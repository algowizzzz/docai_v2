# On-prem server deployment — baby steps

Deploying RiskGPT on a shared server is the laptop setup (BMO-AGENT-SETUP.md)
plus five server things: real hostnames, JWT between app and Document Server,
running as services, firewall, and backups. Same offline tricks apply — every
dependency comes from this repo's `deps` GitHub release.

Primary path below assumes **Windows Server** (matches our mirrored installer
and the laptop runbook). Linux/Docker notes at the end.

---

## Phase 0 — decisions before touching anything

Write down five answers; they get used in later steps verbatim:

1. **SERVERNAME** — the DNS name users' browsers will use,
   e.g. `riskgpt-pilot.bmo.internal` (an IP works for a pilot).
2. **DS port** — 80 if free on the server, else 8090.
3. Who needs access — which subnet/VLAN the firewall must allow.
4. Where documents live — default `C:\riskgpt\webapp\storage\`; put it on a
   disk that is backed up.
5. Three secrets (generate random 32+ char strings, store in the bank's
   secret vault, never in git):
   - `SESSION_SECRET` (login cookies)
   - `ds_jwt_secret` (app ↔ Document Server trust)
   - the LLM API key (optional)

## Phase 1 — dependency preflight (same as laptop)

On the server, in cmd.exe:

    node --version          → need v22.5+ (else Node LTS .msi from nodejs.org)
    netstat -ano | findstr :80 | findstr LISTENING   → decides DS port
    curl -s -o NUL -w "%{http_code}" https://github.com   → must be 200/301

Skip-list (already solved by the `deps` release — no Artifactory needed):
npm packages (`node_modules.zip`), Document Server installer
(`onlyoffice-documentserver-win.exe`), pdf2docx wheels
(`python-wheels-win64.zip`).

## Phase 2 — install Document Server

Exactly BMO-AGENT-SETUP.md Phase 2 (download mirrored exe from the `deps`
release, verify SHA-256, install as admin, healthcheck prints `true`).

## Phase 3 — Document Server config (the server-grade part)

Edit `C:\Program Files\ONLYOFFICE\DocumentServer\config\local.json` as
Administrator. Inside `"services" -> "CoAuthoring"` ensure BOTH of these:

    "request-filtering-agent": { "allowPrivateIPAddress": true, "allowMetaIPAddress": true },
    "secret": {
      "session": { "string": "YOUR-ds_jwt_secret-HERE" },
      "inbox":   { "string": "YOUR-ds_jwt_secret-HERE" },
      "outbox":  { "string": "YOUR-ds_jwt_secret-HERE" }
    },
    "token": { "enable": { "browser": true, "request": { "inbox": true, "outbox": true } } }

Restart all ONLYOFFICE services (services.msc). CHECK: healthcheck still
`true`. From now on Document Server refuses any unsigned request — that is
the point.

(The private-IP allowance stays because app and DS talk over the internal
address; with proper DNS names + HTTPS you can later tighten it.)

## Phase 4 — app setup

As on the laptop: repo to `C:\riskgpt` (clone or ZIP), `node_modules.zip`
from the release extracted into `webapp\`, optional Python venv + wheels for
PDF tables.

Then create `C:\riskgpt\webapp\.env` with THREE lines (no quotes):

    deepseek_api_key=sk-...            (optional)
    ds_jwt_secret=YOUR-ds_jwt_secret-HERE
    (SESSION_SECRET goes via environment, next phase)

The app auto-signs every editor config and verifies every save-callback when
`ds_jwt_secret` is present — no further code steps.

## Phase 5 — hostnames (the #1 on-prem gotcha)

`localhost` no longer works because OTHER machines' browsers must reach both
the app and Document Server. Set these when starting the app (or edit
`scripts\start-windows.bat`):

    set DS_PUBLIC=http://SERVERNAME:80          ← what users' browsers load the editor from
    set APP_FOR_DS=http://SERVERNAME:3001       ← what Document Server calls back to
    set SESSION_SECRET=YOUR-SESSION_SECRET
    set PLATFORM_LAUNCH_URL=http://SERVERNAME:3999/?app=riskgpt

And for the mock platform:

    set APP_SSO_URL=http://SERVERNAME:3001/sso

Rule of thumb: if any of these says `localhost`, only people sitting at the
server can use the tool.

## Phase 6 — run as services (survive reboots)

Simplest supported-by-Windows way — two Scheduled Tasks that run at startup
(no extra software). In an admin cmd:

    schtasks /Create /TN "RiskGPT-app" /SC ONSTART /RU SYSTEM /TR "cmd /c set DS_PUBLIC=http://SERVERNAME:80&& set APP_FOR_DS=http://SERVERNAME:3001&& set SESSION_SECRET=YOUR-SESSION_SECRET&& set PLATFORM_LAUNCH_URL=http://SERVERNAME:3999/?app=riskgpt&& cd /d C:\riskgpt\webapp&& node server.js"
    schtasks /Create /TN "RiskGPT-mock" /SC ONSTART /RU SYSTEM /TR "cmd /c set APP_SSO_URL=http://SERVERNAME:3001/sso&& cd /d C:\riskgpt&& node mock-platform\server.js"
    schtasks /Run /TN "RiskGPT-app"
    schtasks /Run /TN "RiskGPT-mock"

(If the org prefers NSSM for real Windows services, same commands wrapped in
`nssm install` — either is fine.) Document Server is already a service.

CHECK: `curl -s http://localhost:3001/healthz` → `{"ok":true}`, then reboot
the server once and check again.

## Phase 7 — firewall

Open inbound TCP **3001, 3999 and the DS port (80/8090)** to the user subnet
from Phase 0. Windows Defender Firewall → Inbound Rules → New Rule → Port.
Nothing else needs to be reachable.

## Phase 8 — corporate fonts (fidelity!)

Copy BMO's licensed .ttf/.otf files into `C:\Windows\Fonts` on the SERVER
(Document Server renders with the server's fonts), then restart the
ONLYOFFICE services so the font cache regenerates. Then re-run the fidelity
spot-check: upload two real BMO documents and compare against Word.

## Phase 9 — backups

Everything that matters is files — one nightly copy job of:

    C:\riskgpt\webapp\storage\        (all documents + versions)
    C:\riskgpt\webapp\data\riskgpt.db (prompts, standard, audit logs)
    C:\riskgpt\webapp\.env            (secrets — or rely on the vault)

Restore = put the files back. CHECK once: copy the two folders elsewhere,
delete a test doc via the UI, restore the copy, confirm the doc is back.

## Phase 10 — verification from a SECOND machine

From a user's PC (not the server):

1. `http://SERVERNAME:3999` → login card → pick admin → lands on Documents.
2. Upload a .docx → Ready tag → opens in the editor.
3. Type in Chat → answer arrives.
4. Save (Ctrl+S), reopen → History shows v2.
5. As role `user`: `/prompts` → 403.

All five pass = deployed.

## Later hardening (not blocking the pilot)

- **HTTPS**: put the bank's standard reverse proxy / load balancer with a TLS
  cert in front of ports 3001/3999/DS, set `COOKIE_SECURE=true`, switch the
  three hostname envs to `https://`.
- **Real SSO**: replace the mock with the agentic platform per
  AUTH-INTEGRATION.md (four env vars point the app at the real endpoints;
  mock task deleted).
- Restrict `allowPrivateIPAddress` once DNS names are final.
- Software intake/licensing: see the maintenance discussion — pin this
  Document Server version; upgrade only on security advisories, re-running
  the fidelity harness.

## If the server is Linux instead

Important difference from Windows: **the Windows installer bundles PostgreSQL
and RabbitMQ, the Linux package does not.** On Linux you install them first,
create the database by hand, then install Document Server.

### Option A — Docker Engine (simplest; free, no Docker Desktop licence)

`webapp/docker-compose.yml` runs Document Server + app, with Postgres and
RabbitMQ already inside the Document Server image — nothing to configure.
If Docker Hub is blocked, move the image in with the same GitHub-release
trick: on a machine with access run
`docker pull onlyoffice/documentserver && docker save onlyoffice/documentserver | gzip > ds-image.tgz`,
upload it to the `deps` release, then on the server
`gunzip -c ds-image.tgz | docker load`.

### Option B — native package (Ubuntu/Debian)

    # 1. PostgreSQL + database
    sudo apt update && sudo apt install -y postgresql
    sudo -i -u postgres psql -c "CREATE DATABASE onlyoffice;"
    sudo -i -u postgres psql -c "CREATE USER onlyoffice WITH password 'onlyoffice';"
    sudo -i -u postgres psql -c "GRANT ALL privileges ON DATABASE onlyoffice TO onlyoffice;"

    # 2. RabbitMQ (pulls Erlang automatically)
    sudo apt install -y rabbitmq-server

    # 3. Document Server repo + install
    sudo apt install -y gnupg2
    curl -fsSL https://download.onlyoffice.com/GPG-KEY-ONLYOFFICE | sudo gpg --dearmor -o /usr/share/keyrings/onlyoffice.gpg
    echo "deb [signed-by=/usr/share/keyrings/onlyoffice.gpg] https://download.onlyoffice.com/repo/debian squeeze main" | sudo tee /etc/apt/sources.list.d/onlyoffice.list
    sudo apt update && sudo apt install -y onlyoffice-documentserver

    # CHECK
    curl -s http://localhost/healthcheck     # -> true

⚠ Step 3 needs `download.onlyoffice.com` reachable. If the proxy blocks it:
ask whether Artifactory proxies the ONLYOFFICE apt repo (banks often proxy
Debian repos even when npm is locked down), or mirror the single
`onlyoffice-documentserver_*.deb` to the `deps` release and
`sudo apt install ./onlyoffice-documentserver_*.deb`.

Config file on Linux is `/etc/onlyoffice/documentserver/local.json` (same JWT
+ request-filtering block as Phase 3); restart with
`sudo supervisorctl restart all`.

### App side (both options)

Identical to Windows: Node + `node_modules.zip`, same env vars. Use systemd
units instead of Scheduled Tasks:

    sudo tee /etc/systemd/system/riskgpt.service >/dev/null <<'EOF2'
    [Unit]
    Description=RiskGPT app
    After=network.target
    [Service]
    WorkingDirectory=/opt/riskgpt/webapp
    Environment=DS_PUBLIC=http://SERVERNAME:80
    Environment=APP_FOR_DS=http://SERVERNAME:3001
    Environment=SESSION_SECRET=YOUR-SESSION_SECRET
    Environment=PLATFORM_LAUNCH_URL=http://SERVERNAME:3999/?app=riskgpt
    ExecStart=/usr/bin/node server.js
    Restart=always
    [Install]
    WantedBy=multi-user.target
    EOF2
    sudo systemctl enable --now riskgpt

(and a matching `riskgpt-mock.service` running `node mock-platform/server.js`
with `APP_SSO_URL=http://SERVERNAME:3001/sso`).
