// ---------------------------------------------------------------
// Safety net: show errors instead of dying silently
// ---------------------------------------------------------------
window.onerror = function (msg, src, line, col, err) {
  console.error("GLOBAL ERROR:", msg, "at line", line, err);
};

// Fallback so the script never crashes on browsers / http pages
// where crypto.randomUUID is missing (this used to kill the login button)
function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// Set window.API_BASE in config.js (your Render URL). Falls back to local dev.
const API_BASE =
  (window.API_BASE || "").replace(/\/$/, "") || "http://127.0.0.1:8000";

// ---------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------
function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {}
}
function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}

let SESSION_ID = safeGet("session_id");
if (!SESSION_ID) {
  SESSION_ID = uuid();
  safeSet("session_id", SESSION_ID);
}
const authHeaders = (extra = {}) => ({ "X-Session-ID": SESSION_ID, ...extra });

async function errorMessage(response, fallback) {
  try {
    const body = await response.json();
    if (body && body.detail) return String(body.detail);
  } catch (_) {}
  return fallback;
}

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
const API = {
  async uploadDocument(file) {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`${API_BASE}/upload`, {
      method: "POST",
      headers: authHeaders(),
      body: formData,
    });

    if (!response.ok) {
      throw new Error(await errorMessage(response, "Upload failed"));
    }

    const data = await response.json();

    return {
      id: uuid(),
      name: data.filename,
      pages: data.pages ?? "-",
      status: "indexed",
    };
  },

  async listDocuments() {
    const response = await fetch(`${API_BASE}/documents`, {
      headers: authHeaders(),
    });
    if (!response.ok) throw new Error("Could not load documents");
    const data = await response.json();
    return data.documents.map((d) => ({
      id: uuid(),
      name: d.name,
      pages: d.pages ?? "-",
      status: "indexed",
    }));
  },

  async askQuestion(question) {
    const response = await fetch(`${API_BASE}/ask`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      throw new Error(await errorMessage(response, "Failed to get answer"));
    }

    const data = await response.json();

    return {
      answer: data.answer,
      citations: [],
    };
  },
};

// ---------------------------------------------------------------
// State + element references
// ---------------------------------------------------------------
const state = {
  user: null,
  documents: [],
};

const signinOverlay = document.getElementById("signin-overlay");
const signinForm = document.getElementById("signin-form");
const signinNameInput = document.getElementById("signin-name");
const guestBtn = document.getElementById("guest-btn");
const appEl = document.getElementById("app");
const userChip = document.getElementById("user-chip");
const signoutBtn = document.getElementById("signout-btn");

const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const catalogDrawer = document.getElementById("catalog-drawer");
const catalogEmpty = document.getElementById("catalog-empty");
const docCount = document.getElementById("doc-count");

const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatThread = document.getElementById("chat-thread");
const sendBtn = document.getElementById("send-btn");

// ---------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------
function enterApp(name) {
  state.user = name || "Guest";
  safeSet("user", state.user);

  userChip.textContent = state.user;
  signinOverlay.hidden = true;
  appEl.hidden = false;

  chatInput.focus();
}

signinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  enterApp(signinNameInput.value.trim());
});

guestBtn.addEventListener("click", () => enterApp("Guest"));

signoutBtn.addEventListener("click", () => {
  safeRemove("user");
  appEl.hidden = true;
  signinOverlay.hidden = false;
  signinNameInput.value = "";
});

// Auto sign-in if the user was already signed in
const savedUser = safeGet("user");
if (savedUser) {
  enterApp(savedUser);
}

// ---------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------
fileInput.addEventListener("change", async (e) => {
  try {
    await handleFiles(e.target.files);
  } catch (err) {
    console.error("Upload error:", err);
  }
  fileInput.value = ""; // allow re-uploading the same file
});

["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    const placeholderId = `pending-${uuid()}`;
    renderPendingCard(placeholderId, file.name);
    try {
      const doc = await API.uploadDocument(file);
      state.documents.push(doc);
      replacePendingCard(placeholderId, doc);
    } catch (err) {
      removeCard(placeholderId);
      console.error("Upload failed:", err);
      alert(`Couldn't upload ${file.name}: ${err.message}`);
    }
    updateDocCount();
  }
}

function renderPendingCard(id, name) {
  catalogEmpty.style.display = "none";
  const card = document.createElement("div");
  card.className = "index-card";
  card.id = id;
  card.innerHTML = `
  <p class="doc-name">${escapeHtml(name)}</p>
  <p class="doc-meta">
    <span>indexing…</span>
    <span>⏳</span>
  </p>
`;
  catalogDrawer.appendChild(card);
}

function replacePendingCard(id, doc) {
  const card = document.getElementById(id);

  if (!card) return;

  card.innerHTML = `
    <div class="doc-header">
      <p class="doc-name">${escapeHtml(doc.name)}</p>

      <button class="delete-btn" type="button">
        🗑️
      </button>
    </div>

    <p class="doc-meta">
      <span class="doc-status">
        indexed · ${escapeHtml(String(doc.pages))}p
      </span>

      <span>✓</span>
    </p>
  `;

  const deleteBtn = card.querySelector(".delete-btn");

  deleteBtn.addEventListener("click", async () => {
    const ok = await deleteDocument(doc.name);
    if (ok) card.remove();
  });
}

function removeCard(id) {
  const card = document.getElementById(id);
  if (card) card.remove();
}

function updateDocCount() {
  const n = state.documents.length;
  docCount.textContent = `${n} document${n === 1 ? "" : "s"}`;
  catalogEmpty.style.display = n ? "none" : "";
}

// ---------------------------------------------------------------
// Chat
// ---------------------------------------------------------------
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;

  removeIntro();
  addUserMessage(question);
  chatInput.value = "";
  sendBtn.disabled = true;

  const typingEl = addTypingIndicator();

  try {
    const { answer, citations } = await API.askQuestion(question);
    typingEl.remove();
    addAssistantMessage(answer, citations);
  } catch (err) {
    typingEl.remove();
    addAssistantMessage(
      "Something went wrong reaching the assistant. If the server was idle, it may be waking up — please try again in a few seconds.",
      []
    );
    console.error(err);
  } finally {
    sendBtn.disabled = false;
    chatInput.focus();
  }
});

function removeIntro() {
  const intro = document.querySelector(".thread-intro");
  if (intro) intro.remove();
}

function addUserMessage(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.innerHTML = `<div class="msg-bubble">${escapeHtml(text)}</div>`;
  chatThread.appendChild(el);
  scrollToBottom();
}

function addTypingIndicator() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="msg-bubble typing">Retrieving relevant passages…</div>`;
  chatThread.appendChild(el);
  scrollToBottom();
  return el;
}

function addAssistantMessage(text, citations) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  const msgId = uuid().slice(0, 8);

  const tabsHtml = citations
    .map(
      (c, i) => `
      <button class="citation-tab" type="button" data-target="cite-${msgId}-${i}">
        Source ${i + 1} · ${escapeHtml(c.doc)}
      </button>`
    )
    .join("");

  const cardsHtml = citations
    .map(
      (c, i) => `
      <div class="citation-card" id="cite-${msgId}-${i}">
        <p class="cite-source"><span>${escapeHtml(c.doc)}</span><span>p. ${c.page}</span></p>
        <p class="cite-excerpt">"${escapeHtml(c.excerpt)}"</p>
      </div>`
    )
    .join("");

  el.innerHTML = `
    <div class="msg-bubble">${escapeHtml(text)}</div>
    ${citations.length ? `<div class="citations">${tabsHtml}</div>${cardsHtml}` : ""}
  `;

  chatThread.appendChild(el);
  wireCitationTabs(el);
  scrollToBottom();
}

function wireCitationTabs(container) {
  container.querySelectorAll(".citation-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.classList.toggle("open");
    });
  });
}

function scrollToBottom() {
  chatThread.scrollTop = chatThread.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---------------------------------------------------------------
// Delete + restore
// ---------------------------------------------------------------
async function deleteDocument(filename) {
  try {
    const response = await fetch(
      `${API_BASE}/delete/${encodeURIComponent(filename)}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      }
    );

    if (!response.ok) {
      throw new Error("Delete failed");
    }

    state.documents = state.documents.filter((doc) => doc.name !== filename);
    updateDocCount();
    return true;
  } catch (err) {
    console.error(err);
    alert("Couldn't delete the document.");
    return false;
  }
}

async function restoreDocuments() {
  try {
    const docs = await API.listDocuments();
    for (const doc of docs) {
      const id = `pending-${uuid()}`;
      renderPendingCard(id, doc.name);
      state.documents.push(doc);
      replacePendingCard(id, doc);
    }
    updateDocCount();
  } catch (err) {
    console.warn("Could not restore documents:", err);
  }
}
restoreDocuments();
