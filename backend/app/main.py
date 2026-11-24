import io
import os
import sys
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

sys.path.append(str(Path(__file__).resolve().parents[2]))

from document_processor.chunk_text import chunk_text  # noqa: E402
from document_processor.clean_text import clean_text  # noqa: E402

load_dotenv()

# ---------------------------------------------------------------- config
EMBED_MODEL = os.getenv("EMBED_MODEL", "gemini-embedding-001")
EMBED_DIM = 768
GEN_MODEL = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
TOP_K = 5
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_SESSIONS = 50  # oldest idle sessions are dropped (keeps RAM bounded)
ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}

# Comma-separated list, e.g. "https://my-app.netlify.app". "*" = allow any origin.
_origins = os.getenv("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in _origins.split(",") if o.strip()]

app = FastAPI(title="SmartDoc AI Backend", version="2.0")

# Sessions are identified by an X-Session-ID header (not cookies), so no
# credentials are needed -> "*" origins is valid and cross-site safe.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# session_id -> {filename: {"chunks": [str], "vectors": np.ndarray, "pages": int|None}}
STORE: "OrderedDict[str, dict]" = OrderedDict()
LOCK = threading.Lock()


class Question(BaseModel):
    question: str


# ---------------------------------------------------------------- helpers
def get_session_id(value: str | None) -> str:
    if not value or len(value) > 100:
        raise HTTPException(status_code=400, detail="Missing X-Session-ID header.")
    return value


_client = None


def gemini():
    global _client
    if _client is None:
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not set on the server.")
        from google import genai

        _client = genai.Client(api_key=key)
    return _client


def embed(texts: list[str], task: str) -> np.ndarray:
    from google.genai import types

    try:
        out = []
        for i in range(0, len(texts), 100):  # API batch limit
            resp = gemini().models.embed_content(
                model=EMBED_MODEL,
                contents=texts[i : i + 100],
                config=types.EmbedContentConfig(task_type=task, output_dimensionality=EMBED_DIM),
            )
            out.extend(e.values for e in resp.embeddings)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Embedding failed: {exc}")
    arr = np.array(out, dtype=np.float32)
    arr /= np.linalg.norm(arr, axis=1, keepdims=True) + 1e-12
    return arr


def extract_text(filename: str, data: bytes):
    """Return (text, page_count_or_None)."""
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        import fitz  # pymupdf

        with fitz.open(stream=data, filetype="pdf") as doc:
            return "\n".join(p.get_text() for p in doc), doc.page_count
    if ext == ".docx":
        from docx import Document

        doc = Document(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs), None
    return data.decode("utf-8", errors="ignore"), None


# ---------------------------------------------------------------- routes
@app.get("/")
def home():
    return {"message": "SmartDoc AI Backend Running"}


@app.get("/health")
def health():
    return {"status": "Running"}


@app.post("/upload")
def upload_file(file: UploadFile = File(...), x_session_id: str | None = Header(default=None)):
    sid = get_session_id(x_session_id)
    name = Path(file.filename or "").name
    if not name:
        raise HTTPException(status_code=400, detail="No file selected.")
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only PDF, DOCX and TXT files are allowed.")

    data = file.file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB).")

    try:
        text, pages = extract_text(name, data)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not read file: {exc}")

    chunks = chunk_text(clean_text(text), chunk_size=1000, overlap=150)
    if not chunks:
        raise HTTPException(status_code=422, detail="No extractable text found (scanned PDF?).")

    vectors = embed(chunks, "RETRIEVAL_DOCUMENT")

    with LOCK:
        session = STORE.setdefault(sid, {})
        session[name] = {"chunks": chunks, "vectors": vectors, "pages": pages}
        STORE.move_to_end(sid)
        while len(STORE) > MAX_SESSIONS:
            STORE.popitem(last=False)

    return {
        "message": "File uploaded successfully!",
        "filename": name,
        "pages": pages,
        "chunks": len(chunks),
    }


@app.get("/documents")
def list_documents(x_session_id: str | None = Header(default=None)):
    sid = get_session_id(x_session_id)
    with LOCK:
        docs = STORE.get(sid, {})
        return {"documents": [{"name": n, "pages": d["pages"]} for n, d in docs.items()]}


@app.delete("/delete/{filename}")
def delete_document(filename: str, x_session_id: str | None = Header(default=None)):
    sid = get_session_id(x_session_id)
    with LOCK:
        removed = STORE.get(sid, {}).pop(filename, None)
    if removed is None:
        raise HTTPException(status_code=404, detail="File not found.")
    return {"message": f"{filename} deleted successfully."}


@app.post("/ask")
def ask_question(data: Question, x_session_id: str | None = Header(default=None)):
    sid = get_session_id(x_session_id)
    question = data.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is empty.")

    with LOCK:
        docs = dict(STORE.get(sid, {}))
        if sid in STORE:
            STORE.move_to_end(sid)

    if not docs:
        return {
            "question": question,
            "answer": "Please upload a document first (the server may have restarted and cleared earlier uploads).",
        }

    chunks = [c for d in docs.values() for c in d["chunks"]]
    matrix = np.vstack([d["vectors"] for d in docs.values()])
    scores = matrix @ embed([question], "RETRIEVAL_QUERY")[0]
    top = np.argsort(scores)[::-1][:TOP_K]
    context = "\n\n".join(chunks[i] for i in top)

    prompt = f"""You are answering questions ONLY from the provided document excerpts.

If the excerpts contain enough information, answer the question.
If not, reply exactly:
"The answer is not available in the provided document."

Document:
{context}

Question:
{question}

Answer:
"""
    try:
        resp = gemini().models.generate_content(model=GEN_MODEL, contents=prompt)
        answer = resp.text or "The answer is not available in the provided document."
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Answer generation failed: {exc}")

    return {"question": question, "answer": answer}
