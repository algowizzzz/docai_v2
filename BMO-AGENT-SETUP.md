# BMO setup runbook — follow exactly, step by step

You are an AI coding agent setting up **RiskGPT** on a Windows machine with no
Docker and a restrictive corporate proxy. Follow the phases IN ORDER. After
every step there is a **CHECK** — run it and compare with the expected result.
**If a CHECK fails, stop and fix it using the Troubleshooting table at the
bottom before moving on.** Do not improvise, do not upgrade package versions,
do not change ports unless a CHECK tells you to.

## What you are building (context)

Three processes on one machine:

1. **ONLYOFFICE Document Server** — a Windows service that renders and edits
   Word documents. Installed once from a ~1 GB `.exe`. Listens on port **80**
   (or 8090 if chosen at install).
2. **RiskGPT app** — a Node.js server (`webapp\server.js`), port **3001**.
   Stores documents and versions in `webapp\storage\`, settings in a SQLite
   file `webapp\data\riskgpt.db` (created automatically on first run).
3. **Mock auth platform** — a Node.js server (`mock-platform\server.js`),
   port **3999**. Stands in for the real login system. Users start here.

The browser talks to all three. Document Server also calls the app directly
(to fetch documents), which is why the app must be told its own address.

---

## Phase 0 — preflight

Open **Command Prompt** (cmd.exe, not PowerShell, to match the commands below).

**Step 0.1** — check whether Node.js is installed:

    node --version

CHECK: prints `v22.x` or higher (e.g. `v24.2.0`). If "not recognized" or the
version is below 22.5 → install Node in Phase 1.

**Step 0.2** — check whether port 80 is free (Document Server wants it):

    netstat -ano | findstr :80 | findstr LISTENING

CHECK: ideally prints nothing. If something is listening on `0.0.0.0:80` or
`[::]:80`, note it — you will pick port **8090** during the Document Server
install instead (usually the culprit is IIS / "World Wide Web Publishing
Service").

**Step 0.3** — check proxy reachability of GitHub:

    curl -s -o NUL -w "%%{http_code}" https://github.com

CHECK: prints `200` (or `301`). If not, GitHub is blocked too — stop and
report to the user; nothing below will work.

---

## Phase 1 — install prerequisites

**Step 1.1 — Node.js** (skip if 0.1 passed): download the Windows `.msi` LTS
installer from https://nodejs.org and run it with defaults. Close and reopen
Command Prompt afterwards. CHECK: `node --version` prints v22.5+.

If npm later fails with network errors, configure the corporate proxy
(replace with the real proxy host:port, ask the user if unknown):

    npm config set proxy http://PROXYHOST:PORT
    npm config set https-proxy http://PROXYHOST:PORT

**Step 1.2 — Python 3 (OPTIONAL, only for high-quality PDF conversion):**
download from https://python.org, run installer, TICK "Add python.exe to
PATH". CHECK: `python --version` prints 3.10+. If Python cannot be installed,
skip it — PDF upload still works with reduced table quality.

**Step 1.3 — Document Server installer:** download
`onlyoffice-documentserver-win.exe` from this repo's GitHub Releases page:
https://github.com/algowizzzz/docai_v2/releases/tag/deps
(mirrored there because download.onlyoffice.com is blocked by the proxy).
CHECK the SHA-256 matches the release notes:

    certutil -hashfile onlyoffice-documentserver-win.exe SHA256

---

## Phase 2 — install Document Server

**Step 2.1** — run the downloaded `.exe` (requires local admin).

⚠ **IF YOU DO NOT HAVE ADMIN / UAC CANNOT BE APPROVED: STOP HERE and read
NO-ADMIN.md.** Document Server CANNOT be made portable (its installer payload
is a proprietary archive; verified — do not spend time trying to extract it,
and note that portable Erlang/RabbitMQ do NOT substitute for it). NO-ADMIN.md
gives the two working paths: point the app at a Document Server running on
another machine that has admin, or run the app in degraded mode without the
editor. Report to the user which path you are taking. Accept defaults. If the
installer asks for a port and Step 0.2 found port 80 busy, enter **8090**.

**Step 2.2** — wait ~2 minutes after the installer finishes, then:

    curl -s http://localhost/healthcheck

(use `http://localhost:8090/healthcheck` if you chose 8090)
CHECK: prints `true`. If connection refused, wait 2 more minutes and retry;
then see Troubleshooting.

**Step 2.3** — allow Document Server to fetch documents from the app.
Open **Notepad as Administrator**, then open the file:

    C:\Program Files\ONLYOFFICE\DocumentServer\config\local.json

Inside the existing `"services" -> "CoAuthoring"` object, add this key
(keep the JSON valid — add a comma after the previous entry if needed):

    "request-filtering-agent": { "allowPrivateIPAddress": true, "allowMetaIPAddress": true }

Save the file. Then restart the Document Server services: open `services.msc`
and restart every service whose name starts with **ONLYOFFICE** (or reboot the
machine). CHECK: `curl -s http://localhost/healthcheck` prints `true` again.

---

## Phase 3 — set up the app

**Step 3.1** — get the code. Either:

    git clone https://github.com/algowizzzz/docai_v2 C:\riskgpt

or, if git is unavailable, download the repo ZIP from
https://github.com/algowizzzz/docai_v2 (green "Code" button → Download ZIP)
and extract it to `C:\riskgpt`. CHECK: the file
`C:\riskgpt\webapp\server.js` exists.

**Step 3.2** — install app dependencies:

    cd C:\riskgpt\webapp
    npm install

CHECK: ends with "added N packages" and NO line containing `ERR!`.

**Step 3.2-OFFLINE (use this if npm install fails with network/Artifactory
errors):** download `node_modules.zip` from the repo's `deps` release
(https://github.com/algowizzzz/docai_v2/releases/tag/deps), verify its SHA-256
against the release notes with `certutil -hashfile node_modules.zip SHA256`,
then extract it so that the folder `C:\riskgpt\webapp\node_modules\express`
exists (the zip contains a single `node_modules` folder — extract INTO
`C:\riskgpt\webapp`). CHECK:

    node -e "require('C:/riskgpt/webapp/node_modules/express'); console.log('deps ok')"

→ prints `deps ok`. Skip `npm install` entirely in this case.

**Step 3.3 (OPTIONAL, needs Python from 1.2)** — PDF conversion venv:

    cd C:\riskgpt\webapp
    python -m venv pdfenv
    pdfenv\Scripts\pip install pdf2docx

CHECK: `pdfenv\Scripts\python -c "import pdf2docx; print('ok')"` prints `ok`.

**Step 3.3-OFFLINE (use if pip fails with network errors):** download
`python-wheels-win64.zip` from the `deps` release, verify SHA-256, extract to
`C:\riskgpt\wheels`, then:

    pdfenv\Scripts\pip install --no-index --find-links C:\riskgpt\wheels pdf2docx

Same CHECK as above. (Wheels included for Python 3.12 and 3.13, 64-bit —
`python --version` must be one of those.)

**Step 3.4 (OPTIONAL)** — LLM key. Create the file `C:\riskgpt\webapp\.env`
containing exactly one line (ask the user for the key; NEVER commit this file):

    deepseek_api_key=sk-XXXXXXXXXXXXXXXX

Without it, chat and AI Analysis return clearly-labelled mock answers —
everything else still works. If the proxy blocks api.deepseek.com, also set
`HTTPS_PROXY` in the environment, or skip the key.

**Step 3.5 (OPTIONAL — only if you, the agent, want to drive a browser for
your own verification/testing):** Playwright is already inside
`node_modules.zip`. Its browsers cannot be downloaded through the proxy, so
use the pre-bundled ones: download `pw-browsers-win64.zip` from the `deps`
release, verify SHA-256, extract to `C:\riskgpt\pw-browsers`, and set this
environment variable in any window where you run Playwright:

    set PLAYWRIGHT_BROWSERS_PATH=C:\riskgpt\pw-browsers

CHECK:

    cd C:\riskgpt\webapp
    set PLAYWRIGHT_BROWSERS_PATH=C:\riskgpt\pw-browsers
    node -e "require('playwright').chromium.launch({headless:true}).then(b=>{console.log('playwright ok');return b.close()})"

→ prints `playwright ok`. NEVER run `npx playwright install` (it will hang on
the blocked CDN — the browsers are already there).

---

## Phase 4 — run it

**Step 4.1** — IF Document Server is on port 80, simply double-click (or run):

    C:\riskgpt\scripts\start-windows.bat

IF Document Server is on port 8090, first edit that .bat file and change
`set DS_PUBLIC=http://localhost:80` to `http://localhost:8090`, then run it.
Two console windows open — leave both running.

**Step 4.2** — CHECKS, in order:

    curl -s http://localhost:3001/healthz

→ must print `{"ok":true}`

    curl -s -o NUL -w "%%{http_code}" http://localhost:3999/

→ must print `200`

**Step 4.3** — browser smoke test (do these in a real browser):

1. Open `http://localhost:3999` → a "Mock Agentic Platform" login card
   appears. Pick role **admin**, click "Open RiskGPT".
2. You land on a blue "BMO | RiskGPT" **Documents** page.
3. Drag any small `.docx` file onto the drop zone → it appears in the list
   with a green **Ready** tag.
4. Click the document → a loading spinner, then the Word editor renders the
   document, with a "RiskGPT AI Assistant" panel on the left showing three
   buttons: Chat / AI Analysis / Standardize.
5. Type anything into Chat and press Send → an answer appears (marked
   `[MOCK LLM …]` if no API key was configured — that is success, not an
   error).
6. Click "AI Analysis" in the top-right of the Documents page → the admin
   page with "Policy Review" prompt group and the Document standard editor.

If all six pass, setup is COMPLETE. Report success to the user with a list of
which optional steps (1.2/3.3/3.4) were skipped.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `healthcheck` never prints `true` | Document Server services still starting, or port clash | Wait 2–3 min. Check `services.msc` → all ONLYOFFICE services "Running". If port clash, reinstall choosing port 8090 and update the .bat |
| Editor page stuck on spinner, then error | App can't be reached by Document Server, or Step 2.3 skipped | Verify Step 2.3 config + service restart. Verify `APP_FOR_DS=http://localhost:3001` is set in the .bat window |
| Upload works but editor says "document could not be opened" | Wrong `DS_PUBLIC` port in .bat | Match the port Document Server actually uses (80 vs 8090) |
| Browser redirects to `localhost:3999` and it fails to load | Mock platform window closed | Re-run the .bat; keep both windows open |
| `npm install` fails with ECONNRESET/ETIMEDOUT | Corporate proxy | Step 1.1 npm proxy config |
| PDF upload shows "Failed" | No pdfenv AND Document Server unreachable | Do Step 3.3, or fix Document Server, then re-upload |
| Chat answers start with `[MOCK LLM` | No API key — expected default | Step 3.4 if a real key is wanted |
| Chat answers start with `[LLM error:` | Key set but api.deepseek.com unreachable | Proxy: set `HTTPS_PROXY` env in the app window, or remove the key |
| Port 3001 or 3999 already in use | Another process | `netstat -ano | findstr :3001` → `taskkill /PID <pid> /F`, or set `PORT=` env before starting |
| Everything worked yesterday, blank editor today | Document Server services stopped after reboot | `services.msc` → start ONLYOFFICE services |

## Hard rules for the agent

- Never `npm update`, never change dependency versions, never edit files not
  named in this runbook.
- Never commit `webapp\.env`, `webapp\storage\`, or `webapp\data\` to git.
- If a CHECK fails twice after applying the listed fix, stop and report the
  exact command output to the user instead of trying alternatives.
