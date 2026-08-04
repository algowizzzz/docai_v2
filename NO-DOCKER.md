# Running RiskGPT without Docker (BMO laptop)

Docker is only a packaging convenience — the app needs a running ONLYOFFICE
Document Server, and that can be a **native Windows install**. Everything else
is portable (Node + optional Python).

## Decision tree

1. **Windows laptop + local admin rights** → install Document Server natively
   (this guide). Recommended path.
2. **Windows laptop, NO admin rights** → you cannot install Document Server
   (it registers Windows services: PostgreSQL, RabbitMQ, nginx). Options:
   - Point the app at a Document Server running on any reachable machine
     (an approved server/VM inside the network): set `DS_PUBLIC` to its URL
     and `APP_FOR_DS` to your laptop's URL as seen from that server.
   - Ask IT for a one-off elevated install of the .exe below.
3. **macOS** → no native Document Server exists; Docker is mandatory on Mac.

## Step 1 — get the installers past the proxy

The Document Server Windows installer (~1 GB) is attached to this repo's
GitHub Releases (`deps` release) because download.onlyoffice.com may be
blocked. Verify the SHA-256 in the release notes after download. Source:
`https://download.onlyoffice.com/install/documentserver/windows/onlyoffice-documentserver.exe`
(AGPL-3.0 — redistribution permitted; still, keep your test approval in
writing since this bypasses the usual software-intake route).

Also needed, from their official sites (usually proxy-allowed) or the same
release: **Node.js LTS ≥ 22.5** (nodejs.org Windows .msi) and optionally
**Python 3.10+** (python.org) for PDF table conversion.

## Step 2 — install Document Server

Run `onlyoffice-documentserver.exe` (needs admin). Accept defaults; it
installs PostgreSQL, RabbitMQ and nginx as services and serves on **port 80**
(pick 8090 during install if offered, otherwise port 80 is fine — just use it
in Step 4). After install, `http://localhost` (or `:8090`) shows the ONLYOFFICE
welcome page.

## Step 3 — get the app

`git clone https://github.com/algowizzzz/docai_v2` (or download the repo ZIP
from GitHub), then:

```
cd webapp
npm install
```

Optional PDF support:

```
python -m venv pdfenv
pdfenv\Scripts\pip install pdf2docx
```

(The app auto-detects `pdfenv\Scripts\python.exe` on Windows; without it,
PDF uploads still work via Document Server conversion, minus real tables.)

## Step 4 — run

Without Docker there is no `host.docker.internal` — both services run on the
same machine, so tell each side how to reach the other:

```
set DS_PUBLIC=http://localhost:80
set APP_FOR_DS=http://localhost:3001
node server.js
```

In a second terminal: `node ..\mock-platform\server.js` (auth mock, :3999).
Open http://localhost:3999 → sign in → RiskGPT.

## Step 5 — Document Server allowances (same as the Docker pilot)

Edit `%ProgramFiles%\ONLYOFFICE\DocumentServer\config\local.json` and add,
under `services.CoAuthoring`:

```json
"request-filtering-agent": { "allowPrivateIPAddress": true, "allowMetaIPAddress": true }
```

then restart the ONLYOFFICE services (or reboot). This lets Document Server
fetch documents from `http://localhost:3001`. (Production replaces this with
proper hostnames + DS JWT.)

Optional white-label steps (logo/About) mirror HANDOFF.md — same files, under
`%ProgramFiles%\ONLYOFFICE\DocumentServer\web-apps\...`.

## Known Windows notes

- The app no longer needs the `unzip` CLI (pure-JS since commit for this doc).
- The editor plugins load one script from `onlyoffice.github.io` — if the
  proxy blocks it, download `plugins.js` once and serve it locally (change
  the `<script src>` at the top of `webapp/plugin/index.html`).
- Ports used: 80 or 8090 (Document Server), 3001 (app), 3999 (mock auth).
- The DeepSeek call needs outbound HTTPS to api.deepseek.com — through a
  corporate proxy set `HTTPS_PROXY` env, or use the platform `kb_chat_url`.
