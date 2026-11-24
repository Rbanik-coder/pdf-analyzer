# SmartDoc AI

- `frontend/` — static site (HTML/CSS/JS, no build) → deploy on **Netlify**
- `backend/` — FastAPI API → deploy on **Render** (`render.yaml` included)

## Run locally
```bash
pip install -r backend/requirements.txt
export GEMINI_API_KEY=your_key          # Windows: set GEMINI_API_KEY=your_key
uvicorn backend.app.main:app --port 8000
# in another terminal
cd frontend && python -m http.server 5500   # open http://localhost:5500
```

## Deploy
1. **Render**: New → Web Service → this repo. Runtime Python, Root Directory blank,
   Build `pip install -r backend/requirements.txt`,
   Start `uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT`,
   Health Check Path `/health`. Env vars: `GEMINI_API_KEY`, `PYTHON_VERSION=3.12.8`,
   `ALLOWED_ORIGINS` (your Netlify URL, or `*`).
2. Put the Render URL in `frontend/config.js`: `window.API_BASE = "https://xxx.onrender.com";`
3. **Netlify**: Add new site → this repo. Build command blank, Publish directory `frontend`.
4. Set Render `ALLOWED_ORIGINS` to the Netlify URL (no trailing slash) and redeploy.

Uploads are kept in server memory per browser session (`X-Session-ID`), so a Render
restart/sleep clears them; re-upload if that happens.
