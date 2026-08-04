# RiskGPT — runtime requirements

Two deployment paths. Docker is strongly recommended; without Docker the
document engine dictates your OS choice.

## The four runtime components

| Component | What it is | Required? |
|---|---|---|
| Node.js app (`webapp/`) | Library, auth, versioning, prompt chains, APIs | Always |
| ONLYOFFICE Document Server | The Word engine (rendering/editing/conversion) | Always — this is the big one |
| Python + pdf2docx (`webapp/pdfenv/`) | PDF→Word conversion with real tables | Only for PDF uploads (app falls back to Document Server conversion without it) |
| Agentic platform (or `mock-platform/`) | Auth authority (SSO) | Always (mock is fine for dev) |

## Path A — with Docker (recommended)

1. **Docker** — Docker Desktop on Windows/Mac, Docker Engine on Linux.
   ⚠ BMO note: Docker Desktop requires a paid license for large enterprises;
   check whether BMO has one, or use a Linux VM with free Docker Engine.
2. **Node.js ≥ 22.5** (24.x tested) — for the app itself in dev
   (`npm install` pulls express, multer, docx — pure JS, no native builds).
   In full-compose deploys the app runs in its own container instead.
3. `docker compose up -d` in `webapp/` starts Document Server + app.
   First pull of `onlyoffice/documentserver` is ~4GB.

Known gap: the app's `Dockerfile` does not yet install Python/pdf2docx, so a
fully containerized app converts PDFs via Document Server (tables become
positioned text). To keep table reconstruction in Docker, extend the
Dockerfile with `python3 -m venv pdfenv && pdfenv/bin/pip install pdf2docx`.

## Path B — without Docker

Document Server must then be installed natively, which fixes your OS options:

- **Linux (Ubuntu/Debian)** — best supported: `apt install onlyoffice-documentserver`
  (pulls its own nginx, PostgreSQL, RabbitMQ automatically). Plus Node ≥ 22.5
  and Python 3.8+ for pdf2docx.
- **Windows Server / Windows 10+** — ONLYOFFICE publishes a native Windows
  installer (bundles PostgreSQL/Erlang/RabbitMQ). Plus Node ≥ 22.5 (installer
  from nodejs.org) and Python 3 (python.org) for pdf2docx.
  ⚠ The shading endpoint shells out to `unzip` — present on macOS/Linux, NOT
  on Windows by default: install Info-ZIP, or use Git-Bash's unzip on PATH.
- **macOS** — no native Document Server exists. On a Mac, Docker is mandatory
  (that's why the pilot runs it in Docker).

## Exact dependency list

**Node (package.json, `npm install`):** express, multer, docx.
Uses Node's built-in `node:sqlite` — no database server, no native modules.

**Python (only in `webapp/pdfenv`, only for PDF uploads):**
`pip install pdf2docx` — pulls PyMuPDF, python-docx, opencv-python-headless,
numpy, fonttools. (numpy/Pillow on the system Python are NOT required — they
were used for test tooling only.)

**System tools:** `unzip` (shading analysis). LibreOffice is NOT required at
runtime (it was used only by the local fidelity test harness).

**Network / firewall (matters on a BMO laptop):**
- Outbound HTTPS to `api.deepseek.com` (or your internal LLM endpoint) —
  corporate proxy must allow it, or set the worker `kb_chat_url` instead
- The editor plugins load `https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js`
  — if the proxy blocks GitHub Pages, vendor this one file locally and change
  the `<script src>` in both plugin `index.html` files (recommended for prod
  anyway)
- Ports: app 3001, Document Server 8090, mock platform 3999 (dev only) —
  all localhost, no inbound holes needed

**Hardware:** ~6GB free disk (mostly the Document Server image), 8GB RAM
comfortable (Document Server wants 2–4GB), any x86-64 or ARM64.

**Secrets/env:** `deepseek_api_key` (or `DEEPSEEK_API_KEY` env),
`SESSION_SECRET`, and the platform URLs/secrets from AUTH-INTEGRATION.md.
Defaults point at the local mock platform.

## Quick start (dev, any OS with Docker)

```
docker run -d --name onlyoffice-pilot -p 8090:80 -e JWT_ENABLED=false onlyoffice/documentserver
cd webapp && npm install && node server.js          # app on :3001
node ../mock-platform/server.js                     # auth mock on :3999
python3 -m venv webapp/pdfenv && webapp/pdfenv/bin/pip install pdf2docx   # optional, PDF uploads
```
Then open http://localhost:3999 and sign in.

Note: the pilot also applied two in-container tweaks that a fresh Document
Server won't have (logo files replaced, About button CSS, private-IP fetch
allowed in local.json) — see HANDOFF.md; bake them into your deploy scripts.
