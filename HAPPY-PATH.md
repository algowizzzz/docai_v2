# Happy path — install on a server with admin rights and normal internet

No mirrors, no zips, no workarounds: everything below comes from official
sources. ~30 minutes.

Use this document when the server can reach the internet normally.
If a download is blocked, switch to the mirrored copies on the repo's `deps`
release (see BMO-AGENT-SETUP.md / NO-DOCKER.md). If you have no admin rights
at all, see NO-ADMIN.md.

Before starting, run the preflight so you know where you stand:

    bash scripts/preflight-linux.sh          # Linux
    scripts\preflight-windows.bat            # Windows (admin cmd)

---

# Linux (Ubuntu / Debian)

### 1. Node.js 22 LTS

    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

CHECK: `node -v` → v22.x or higher

### 2. PostgreSQL + the database Document Server needs

    sudo apt install -y postgresql
    sudo -i -u postgres psql -c "CREATE DATABASE onlyoffice;" -c "CREATE USER onlyoffice WITH password 'onlyoffice';" -c "GRANT ALL privileges ON DATABASE onlyoffice TO onlyoffice;"

### 3. RabbitMQ (pulls Erlang automatically)

    sudo apt install -y rabbitmq-server

### 4. Document Server (official repo)

    curl -fsSL https://download.onlyoffice.com/GPG-KEY-ONLYOFFICE | sudo gpg --dearmor -o /usr/share/keyrings/onlyoffice.gpg
    echo "deb [signed-by=/usr/share/keyrings/onlyoffice.gpg] https://download.onlyoffice.com/repo/debian squeeze main" | sudo tee /etc/apt/sources.list.d/onlyoffice.list
    sudo apt update && sudo apt install -y onlyoffice-documentserver

CHECK: `curl -s http://localhost/healthcheck` → `true`

### 5. Document Server config (one edit)

Edit `/etc/onlyoffice/documentserver/local.json`. Inside
`services` → `CoAuthoring`, add:

    "request-filtering-agent": { "allowPrivateIPAddress": true, "allowMetaIPAddress": true },
    "secret": {
      "session": { "string": "PICK-A-LONG-RANDOM-STRING" },
      "inbox":   { "string": "PICK-A-LONG-RANDOM-STRING" },
      "outbox":  { "string": "PICK-A-LONG-RANDOM-STRING" }
    },
    "token": { "enable": { "browser": true, "request": { "inbox": true, "outbox": true } } }

Then:

    sudo supervisorctl restart all

CHECK: `curl -s http://localhost/healthcheck` → `true` again

### 6. The app

    git clone https://github.com/algowizzzz/docai_v2 /opt/riskgpt && cd /opt/riskgpt/webapp && npm install

### 7. PDF table conversion (optional)

    cd /opt/riskgpt/webapp && python3 -m venv pdfenv && pdfenv/bin/pip install pdf2docx

### 8. Secrets

Create `/opt/riskgpt/webapp/.env`:

    ds_jwt_secret=PICK-A-LONG-RANDOM-STRING       ← same string as step 5
    deepseek_api_key=sk-...                       ← optional; without it, AI answers are mocked

### 9. Run it

Replace `SERVERNAME` with the real hostname users will type. **This is the
step people get wrong — `localhost` here means only the server itself can use
the tool.**

    cd /opt/riskgpt/webapp && DS_PUBLIC=http://SERVERNAME:80 APP_FOR_DS=http://SERVERNAME:3001 SESSION_SECRET=ANOTHER-RANDOM-STRING PLATFORM_LAUNCH_URL=http://SERVERNAME:3999/?app=riskgpt node server.js

Second terminal (the stand-in login service):

    cd /opt/riskgpt && APP_SSO_URL=http://SERVERNAME:3001/sso node mock-platform/server.js

### 10. Verify from another machine's browser

`http://SERVERNAME:3999` → sign in as **admin** → upload a .docx → it opens
in the editor with the RiskGPT panel. Done.

### 11. Make it permanent

Add the two systemd units from ONPREM-DEPLOY.md so both processes start on
boot, open the firewall for ports 80 / 3001 / 3999, and copy BMO's licensed
fonts into `/usr/share/fonts` (Document Server renders with the *server's*
fonts) followed by `sudo supervisorctl restart all`.

---

# Windows Server

Same shape, three differences:

1. **Node.js** — `.msi` LTS installer from https://nodejs.org (defaults).
2. **Document Server** — `.exe` from https://www.onlyoffice.com/download-docs.aspx.
   **It bundles PostgreSQL, RabbitMQ and Erlang**, so steps 2 and 3 above do
   not apply. If port 80 is busy, choose 8090 during install.
   CHECK: `curl -s http://localhost/healthcheck` → `true`
3. **Config file** lives at
   `C:\Program Files\ONLYOFFICE\DocumentServer\config\local.json` (same JSON
   as step 5); restart the ONLYOFFICE services in `services.msc` afterwards.

Then:

    git clone https://github.com/algowizzzz/docai_v2 C:\riskgpt
    cd C:\riskgpt\webapp && npm install

Create `C:\riskgpt\webapp\.env` (same two lines as step 8), edit
`scripts\start-windows.bat` to replace `localhost` with `SERVERNAME`, and run
it. Verify from another machine as in step 10, then make it permanent with
the Scheduled Tasks in ONPREM-DEPLOY.md.

---

## What decides whether this really is the happy path

- Server can reach `download.onlyoffice.com` (or `deb.nodesource.com` /
  `registry.npmjs.org` on Linux). Blocked → use the `deps` release mirrors.
- Port 80 is free, or you install Document Server on 8090.
- You have admin/sudo. No admin → NO-ADMIN.md.
- Optional extras that never block the install: Python (PDF table quality)
  and the LLM key (AI answers are clearly-labelled mocks without it).
