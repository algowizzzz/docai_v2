#!/usr/bin/env bash
#
# RiskGPT — one-shot installer for RHEL / Rocky / AlmaLinux 9 (x86_64).
#
#   sudo ./install.sh --check      # verify prerequisites, install NOTHING
#   sudo ./install.sh              # do the full install
#   sudo ./install.sh --hostname riskgpt.bmo.internal
#
# Run it from the folder this file is in (the unzipped riskgpt-linux-packages).
# Everything it needs is either in that folder or on the bank's RHEL mirror —
# it never reaches the internet.
#
# Safe to re-run: every step is skipped if it is already done.
#
set -uo pipefail

VERSION="1.0"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-/opt/riskgpt}"
DB_NAME=onlyoffice; DB_USER=onlyoffice; DB_PWD="${DB_PWD:-onlyoffice}"
CHECK_ONLY=0
HOSTNAME_ARG=""
FAILED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check|--check-only) CHECK_ONLY=1 ;;
    --hostname) HOSTNAME_ARG="${2:-}"; shift ;;
    --hostname=*) HOSTNAME_ARG="${1#*=}" ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

# ---------- output helpers ----------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; N=$'\e[0m'; else B=""; G=""; R=""; Y=""; N=""; fi
step()  { echo; echo "${B}=== $* ${N}"; }
ok()    { echo "  ${G}OK${N}   $*"; }
warn()  { echo "  ${Y}NOTE${N} $*"; }
fail()  { echo "  ${R}FAIL${N} $*"; FAILED=1; }
die()   { echo; echo "${R}STOPPED:${N} $*"; echo "Nothing further was changed. Fix the above and re-run."; exit 1; }

echo "${B}RiskGPT installer v$VERSION${N}   ($([ $CHECK_ONLY = 1 ] && echo 'CHECK ONLY — nothing will be installed' || echo 'full install'))"

# ---------- Phase 0: preflight ----------
step "Phase 0 — preflight"

[ "$(id -u)" = 0 ] || die "run as root:  sudo $0 $*"

if [ -r /etc/redhat-release ]; then
  ok "$(cat /etc/redhat-release)"
else
  die "not a RHEL-family server (no /etc/redhat-release). These packages are RPMs."
fi

EL=$(rpm -E %{rhel} 2>/dev/null || echo "")
case "$EL" in
  9) ERLANG_RPM=$(ls "$HERE"/1-rabbitmq/erlang-*el9*.rpm 2>/dev/null | head -1) ;;
  8) ERLANG_RPM=$(ls "$HERE"/1-rabbitmq/erlang-*el8*.rpm 2>/dev/null | head -1) ;;
  *) die "unsupported RHEL major version '$EL' (need 8 or 9)" ;;
esac
ok "RHEL major version $EL  ->  $(basename "${ERLANG_RPM:-none found}")"

[ "$(uname -m)" = "x86_64" ] || die "these packages are x86_64; this machine is $(uname -m)"

for d in 1-rabbitmq 2-documentserver 3-app-node; do
  [ -d "$HERE/$d" ] || die "folder '$d' missing — run this from inside the unzipped riskgpt-linux-packages folder"
done
ok "package folders present"

if [ -f "$HERE/checksums.sha256" ]; then
  if (cd "$HERE" && sha256sum -c checksums.sha256 >/tmp/riskgpt-sums.log 2>&1); then
    ok "all $(grep -c . "$HERE/checksums.sha256") files match their checksums"
  else
    fail "checksum mismatch — see /tmp/riskgpt-sums.log. Re-download the ZIP."
  fi
else
  warn "checksums.sha256 not found — skipping integrity check"
fi

# --- packages that must come from the bank's mirror ---
step "Phase 0b — packages required from the internal RHEL mirror"

dnf -q makecache >/dev/null 2>&1 || warn "dnf could not refresh metadata — is the internal mirror configured?"

MIRROR_PKGS="postgresql-server postgresql nginx xorg-x11-server-Xvfb gtk3 \
liberation-mono-fonts liberation-sans-fonts liberation-serif-fonts logrotate \
vim-common wget curl ca-certificates alsa-lib atk libXScrnSaver libXtst \
libselinux-utils openssl zlib libcurl libstdc++"

MISSING=""
for p in $MIRROR_PKGS; do
  rpm -q "$p" >/dev/null 2>&1 && continue
  dnf -q info "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  fail "not available on this server's repos:$MISSING"
  echo "       -> ask the server team to add these to the internal mirror."
else
  ok "all ${B}editor dependencies${N} available (installed or on the mirror)"
fi

# Node.js 22 — the default stream is 16 and the app cannot run on it
if command -v node >/dev/null 2>&1 && [ "$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -ge 22 ]; then
  ok "node $(node --version) already installed"
elif dnf -q module list nodejs 2>/dev/null | grep -q '^nodejs *22'; then
  ok "nodejs stream 22 available on the mirror"
else
  fail "nodejs stream 22 NOT available (the default stream 16 will NOT run this app)"
  echo "       -> ask the server team for the nodejs:22 module stream."
fi

# Python 3.14 — optional, only for PDF conversion
if [ -d "$HERE/4-pdf-python" ]; then
  if command -v python3.14 >/dev/null 2>&1; then ok "python3.14 installed"
  elif dnf -q info python3.14 >/dev/null 2>&1; then ok "python3.14 available on the mirror"
  else warn "python3.14 not available — PDF-to-Word conversion will be skipped (everything else works)"
  fi
fi

if [ "$FAILED" = 1 ]; then
  echo
  echo "${R}Prerequisites are missing (see FAIL lines above).${N}"
  echo "Send that list to the server team, then re-run:  sudo $0 --check"
  exit 1
fi

if [ "$CHECK_ONLY" = 1 ]; then
  echo; echo "${G}All prerequisites satisfied.${N} Run without --check to install."
  exit 0
fi

# ---------- Phase 1: RabbitMQ + Erlang ----------
step "Phase 1 — Erlang and RabbitMQ"

if rpm -q erlang >/dev/null 2>&1; then ok "erlang already installed ($(rpm -q --qf '%{VERSION}' erlang))"
else
  dnf install -y "$ERLANG_RPM" >/tmp/riskgpt-erlang.log 2>&1 || die "erlang install failed — see /tmp/riskgpt-erlang.log"
  ok "erlang installed"
fi

if rpm -q rabbitmq-server >/dev/null 2>&1; then ok "rabbitmq-server already installed"
else
  dnf install -y "$HERE"/1-rabbitmq/rabbitmq-server-*.noarch.rpm >/tmp/riskgpt-rabbit.log 2>&1 \
    || die "rabbitmq install failed — see /tmp/riskgpt-rabbit.log"
  ok "rabbitmq-server installed"
fi

systemctl enable --now rabbitmq-server >/dev/null 2>&1
for i in $(seq 1 30); do
  [ "$(systemctl is-active rabbitmq-server)" = active ] && break
  sleep 5
done
[ "$(systemctl is-active rabbitmq-server)" = active ] \
  && ok "rabbitmq-server running" \
  || die "rabbitmq-server did not start — check: systemctl status rabbitmq-server"

# ---------- Phase 2: PostgreSQL ----------
step "Phase 2 — PostgreSQL and the editor's database"

rpm -q postgresql-server >/dev/null 2>&1 || dnf install -y postgresql-server postgresql >/tmp/riskgpt-pg.log 2>&1 \
  || die "postgresql install failed — see /tmp/riskgpt-pg.log"

PGDATA=/var/lib/pgsql/data
if [ -f "$PGDATA/PG_VERSION" ]; then ok "database cluster already initialised"
else
  postgresql-setup --initdb >/tmp/riskgpt-initdb.log 2>&1 || die "initdb failed — see /tmp/riskgpt-initdb.log"
  ok "database cluster initialised"
fi
systemctl enable --now postgresql >/dev/null 2>&1
for i in $(seq 1 20); do [ "$(systemctl is-active postgresql)" = active ] && break; sleep 3; done
[ "$(systemctl is-active postgresql)" = active ] || die "postgresql did not start"

# IMPORTANT ORDER: set password hashing BEFORE creating the user, or the
# password is stored as md5 and scram-sha-256 auth then rejects it.
sudo -u postgres psql -tAc "ALTER SYSTEM SET password_encryption='scram-sha-256';" >/dev/null 2>&1
systemctl restart postgresql; sleep 5
ok "password encryption set to scram-sha-256"

if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
  ok "database '$DB_NAME' already exists"
else
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME;" >/dev/null 2>&1
  ok "database '$DB_NAME' created"
fi
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1; then
  sudo -u postgres psql -c "ALTER USER $DB_USER PASSWORD '$DB_PWD';" >/dev/null 2>&1
  ok "user '$DB_USER' password re-hashed with scram-sha-256"
else
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH password '$DB_PWD';" >/dev/null 2>&1
  ok "user '$DB_USER' created"
fi
sudo -u postgres psql -c "GRANT ALL privileges ON DATABASE $DB_NAME TO $DB_USER;" >/dev/null 2>&1
sudo -u postgres psql -d "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO $DB_USER;" >/dev/null 2>&1

# allow password logins over loopback (RHEL defaults to 'ident', which fails)
if grep -qE '^host[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+ident' "$PGDATA/pg_hba.conf"; then
  cp -p "$PGDATA/pg_hba.conf" "$PGDATA/pg_hba.conf.riskgpt-backup"
  sed -i -E 's|^(host[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+)ident|\1scram-sha-256|' "$PGDATA/pg_hba.conf"
  systemctl restart postgresql; sleep 5
  ok "pg_hba.conf: loopback logins switched to scram-sha-256 (backup kept)"
else
  ok "pg_hba.conf already allows password logins"
fi

if PGPASSWORD="$DB_PWD" psql -h 127.0.0.1 -U "$DB_USER" -d "$DB_NAME" -tAc 'select 1' 2>/dev/null | grep -q 1; then
  ok "CHECK database login works"
else
  die "database login failed. Inspect $PGDATA/pg_hba.conf and re-run."
fi

# ---------- Phase 3: Document Server ----------
step "Phase 3 — ONLYOFFICE Document Server"

DS_RPM=$(ls "$HERE"/2-documentserver/onlyoffice-documentserver-*.rpm 2>/dev/null | head -1)
[ -n "$DS_RPM" ] || die "Document Server rpm not found in 2-documentserver/"

if rpm -q onlyoffice-documentserver >/dev/null 2>&1; then
  ok "Document Server already installed ($(rpm -q --qf '%{VERSION}' onlyoffice-documentserver))"
else
  echo "  installing its dependencies from the mirror (~220 packages, a few minutes)..."
  dnf install -y --allowerasing $MIRROR_PKGS >/tmp/riskgpt-dsdeps.log 2>&1 \
    || die "dependency install failed — see /tmp/riskgpt-dsdeps.log"
  ok "dependencies installed"

  # --nodeps skips exactly two unsatisfiable-offline requirements:
  #   certbot                    - EPEL only; only issues public Let's Encrypt certs
  #   msttcore-fonts-installer   - EPEL deps + downloads fonts from the internet
  # Every real dependency was installed above.
  echo "  installing Document Server (674 MB, several minutes)..."
  rpm -ivh --nodeps "$DS_RPM" >/tmp/riskgpt-ds.log 2>&1 \
    || die "Document Server install failed — see /tmp/riskgpt-ds.log"
  ok "Document Server installed"
fi

if [ -f /etc/onlyoffice/documentserver/local.json ] && grep -q '"dbUser"\|"dbName"' /etc/onlyoffice/documentserver/local.json 2>/dev/null; then
  ok "Document Server already configured"
else
  echo "  configuring (database + message queue)..."
  DB_HOST=localhost DB_PORT=5432 DB_TYPE=postgres DB_NAME="$DB_NAME" \
  DB_USER="$DB_USER" DB_PWD="$DB_PWD" RABBITMQ_SERVER_URL=amqp://guest:guest@localhost \
    documentserver-configure.sh >/tmp/riskgpt-dsconf.log 2>&1 \
    || die "documentserver-configure.sh failed — see /tmp/riskgpt-dsconf.log"
  ok "Document Server configured"
fi

for i in $(seq 1 30); do
  [ "$(curl -s -m 10 http://localhost/healthcheck 2>/dev/null)" = true ] && break
  sleep 5
done
if [ "$(curl -s -m 10 http://localhost/healthcheck 2>/dev/null)" = true ]; then
  ok "CHECK http://localhost/healthcheck -> true"
else
  die "Document Server healthcheck did not return true. Check: systemctl status ds-docservice"
fi

DS_JWT=$(documentserver-jwt-status.sh 2>/dev/null | awk '/JWT secret/{print $4}')
[ -n "$DS_JWT" ] && ok "JWT secret read from Document Server" || warn "could not read the JWT secret"

# ---------- Phase 4: the app ----------
step "Phase 4 — RiskGPT application"

if [ ! -f "$APP_DIR/webapp/server.js" ]; then
  warn "application code not found at $APP_DIR"
  echo "       Copy the repository there first, e.g.:"
  echo "         sudo mkdir -p $APP_DIR && sudo cp -r /path/to/docai_v2/* $APP_DIR/"
  echo "       then re-run this script — the stack above is already installed."
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 22 ]; then
  dnf -y module reset nodejs  >/dev/null 2>&1
  dnf -y module enable nodejs:22 >/dev/null 2>&1
  dnf -y install nodejs >/tmp/riskgpt-node.log 2>&1 || die "nodejs install failed — see /tmp/riskgpt-node.log"
fi
ok "node $(node --version)"

if [ -d "$APP_DIR/webapp/node_modules/express" ]; then
  ok "node packages already present"
else
  TARBALL=$(ls "$HERE"/3-app-node/npm-app-modules-linux.tar.gz 2>/dev/null | head -1)
  if [ -n "$TARBALL" ]; then
    tar xzf "$TARBALL" -C "$APP_DIR/webapp" && ok "node packages installed from the bundle (offline)"
  else
    (cd "$APP_DIR/webapp" && npm install --no-audit --no-fund >/tmp/riskgpt-npm.log 2>&1) \
      && ok "node packages installed with npm" || die "npm install failed — see /tmp/riskgpt-npm.log"
  fi
fi

# optional: PDF -> Word conversion
if [ -d "$HERE/4-pdf-python" ] && ls "$HERE"/4-pdf-python/*.whl >/dev/null 2>&1; then
  if [ -x "$APP_DIR/webapp/pdfenv/bin/python" ]; then
    ok "PDF conversion environment already present"
  elif command -v python3.14 >/dev/null 2>&1 || dnf -q install -y python3.14 >/dev/null 2>&1; then
    python3.14 -m venv "$APP_DIR/webapp/pdfenv" >/dev/null 2>&1
    if "$APP_DIR/webapp/pdfenv/bin/pip" install -q --no-index --find-links "$HERE/4-pdf-python" pdf2docx >/tmp/riskgpt-pip.log 2>&1; then
      ok "PDF conversion packages installed (offline)"
    else
      warn "PDF conversion install failed (see /tmp/riskgpt-pip.log) — PDF upload will use the editor's simpler converter"
    fi
  else
    warn "python3.14 unavailable — skipping PDF conversion (everything else works)"
  fi
fi

# ---------- Phase 5: configuration ----------
step "Phase 5 — configuration"

SERVER_NAME="${HOSTNAME_ARG:-$(hostname -f 2>/dev/null || hostname)}"
[ -n "$SERVER_NAME" ] || SERVER_NAME=$(hostname)
ok "hostname users will type: ${B}$SERVER_NAME${N}   (override with --hostname)"

ENV_FILE="$APP_DIR/webapp/.env"
if [ -f "$ENV_FILE" ]; then
  ok ".env already exists — left untouched"
else
  umask 077
  { echo "ds_jwt_secret=$DS_JWT"
    echo "# deepseek_api_key=      <- optional; without it AI answers are clearly-labelled mocks"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env written (contains the Document Server JWT secret)"
fi

SESSION_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)

cat > /etc/systemd/system/riskgpt.service <<EOF
[Unit]
Description=RiskGPT application
After=network.target postgresql.service ds-docservice.service

[Service]
WorkingDirectory=$APP_DIR/webapp
Environment=DS_PUBLIC=http://$SERVER_NAME:80
Environment=APP_PUBLIC=http://$SERVER_NAME:3001
Environment=APP_FOR_DS=http://localhost:3001
Environment=SESSION_SECRET=$SESSION_SECRET
Environment=PLATFORM_LAUNCH_URL=http://$SERVER_NAME:3999/?app=riskgpt
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/riskgpt-mock.service <<EOF
[Unit]
Description=RiskGPT stand-in login service (replace with the real SSO platform)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment=APP_SSO_URL=http://$SERVER_NAME:3001/sso
ExecStart=/usr/bin/node mock-platform/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now riskgpt riskgpt-mock >/dev/null 2>&1
sleep 8
[ "$(systemctl is-active riskgpt)" = active ] && ok "riskgpt service running (starts on boot)" \
  || warn "riskgpt service not active — check: journalctl -u riskgpt -n 40"
[ "$(systemctl is-active riskgpt-mock)" = active ] && ok "riskgpt-mock service running" \
  || warn "riskgpt-mock not active — check: journalctl -u riskgpt-mock -n 40"

# SELinux: let nginx/DS talk to the app over the loopback
if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
  setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 \
    && ok "SELinux: httpd_can_network_connect enabled" \
    || warn "SELinux is Enforcing — if the editor cannot load documents, run: setsebool -P httpd_can_network_connect 1"
else
  ok "SELinux not enforcing — nothing to do"
fi

# firewall
if systemctl is-active firewalld >/dev/null 2>&1; then
  for p in 80 3001 3999; do firewall-cmd --permanent --add-port=$p/tcp >/dev/null 2>&1; done
  firewall-cmd --reload >/dev/null 2>&1
  ok "firewall: opened TCP 80, 3001, 3999"
else
  warn "firewalld not running — make sure TCP 80, 3001 and 3999 are reachable from user PCs"
fi

# ---------- done ----------
step "Done"
cat <<EOF
  Document Server : http://$SERVER_NAME/          (healthcheck returns true)
  RiskGPT         : http://$SERVER_NAME:3001/
  Sign-in page    : http://$SERVER_NAME:3999/     <- users start here

  Verify from ANOTHER machine's browser: open the sign-in page, choose admin,
  upload a .docx — it should open in the editor with the RiskGPT panel.

  Still to do (not automated on purpose):
    1. Copy BMO's licensed fonts to /usr/share/fonts on THIS server, then
       'systemctl restart ds-docservice' — the editor renders with the
       server's fonts, so this is what makes documents look right.
    2. Optional BMO logo inside the editor header:
       bash $APP_DIR/scripts/brand-documentserver-linux.sh $APP_DIR/webapp/brand/bmo-logo-header.svg
    3. Put the bank's TLS reverse proxy in front and switch the three URLs in
       /etc/systemd/system/riskgpt.service to https://, then:
       systemctl daemon-reload && systemctl restart riskgpt
    4. Replace the stand-in login service with the real SSO platform
       (see AUTH-INTEGRATION.md), then: systemctl disable --now riskgpt-mock

  Logs: journalctl -u riskgpt -f     Install logs: /tmp/riskgpt-*.log
EOF
