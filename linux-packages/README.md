# linux-packages — RPMs for the server team

The office server team could not find **RabbitMQ** and **ONLYOFFICE Document
Server** in the approved package list, so the packages are supplied here as
`.rpm` files for a RHEL-family Linux server (RHEL / Rocky / Alma / CentOS
Stream, x86_64). Erlang is included because RabbitMQ requires it.

## The files

| File | What it is | Size | Where it came from (unmodified) |
|---|---|---|---|
| `erlang-26.2.5.2-1.el8.x86_64.rpm` | Erlang 26 runtime for **RHEL 8** family — RabbitMQ's only dependency. Zero-dependency build by the RabbitMQ team | 21 MB | github.com/rabbitmq/erlang-rpm, release v26.2.5.2 |
| `erlang-26.2.5.2-1.el9.x86_64.rpm` | Same, built for **RHEL 9** family | 21 MB | same release |
| `rabbitmq-server-3.13.7-1.el8.noarch.rpm` | RabbitMQ 3.13.7 (noarch — works on RHEL 8 **and** 9) | 18 MB | github.com/rabbitmq/rabbitmq-server, release v3.13.7 |
| `rabbitmq-server-3.13.7-1.el8.noarch.rpm.asc` | RabbitMQ team's GPG signature for the rpm above | 1 KB | same release |
| `msttcore-fonts-installer-2.6-1.noarch.rpm` | Microsoft core fonts installer. **Optional — skip it on an offline server**; see step 3 for why | 30 KB | downloads.sourceforge.net/project/mscorefonts2 |
| `onlyoffice-documentserver-9.4.0.x86_64.rpm` | ONLYOFFICE Document Server 9.4.0 (AGPL Community Edition) | **674 MB — too big for git (GitHub hard-rejects files over 100 MB), so download it from this repo's Releases page:** https://github.com/algowizzzz/docai_v2/releases/tag/linux-server | download.onlyoffice.com/repo/centos/main/noarch/ |

SHA-256 for the files **in this folder** is in
[`checksums.sha256`](checksums.sha256) — run it from inside `linux-packages/`:

    cd linux-packages && sha256sum -c checksums.sha256

The files downloaded from the Releases page have their own
`linux-server-checksums.sha256` on that page; run that one from the folder you
downloaded them into.

Every step in this file was rehearsed end-to-end on a clean AlmaLinux 9.8
server with no internet access for these components.

## How the security team can verify authenticity

- **Document Server**: the SHA-256 `2a1174a4…c358` matches the checksum
  ONLYOFFICE publishes in its own signed yum repo metadata. Independent check
  from any machine with internet:

      curl -s https://download.onlyoffice.com/repo/centos/main/noarch/repodata/repomd.xml
      # follow the primary.xml.gz link and find the entry for
      # onlyoffice-documentserver-9.4.0.x86_64.rpm — same sha256.

- **RabbitMQ**: verify the detached signature with the RabbitMQ release
  signing key (https://www.rabbitmq.com/docs/signatures):

      gpg --verify rabbitmq-server-3.13.7-1.el8.noarch.rpm.asc rabbitmq-server-3.13.7-1.el8.noarch.rpm

- **Erlang**: the rpms are signed by the same RabbitMQ key — after importing
  it: `rpm --checksig erlang-*.rpm`.

## The fast way: run the installer

`install.sh` does everything below, in order, with a check after each step.
Run it from inside the unzipped `riskgpt-linux-packages` folder:

    sudo ./install.sh --check                          # verifies prerequisites, installs NOTHING
    sudo ./install.sh --hostname riskgpt.bmo.internal  # the real install

Run `--check` **first**. It lists anything missing from the internal RHEL
mirror so the server team can fix it in one pass instead of discovering the
gaps one at a time mid-install. The installer is safe to re-run — every step
is skipped if it is already done — and it never reaches the internet.

It ends with the URLs to test and a short list of the four things it
deliberately does NOT automate (corporate fonts, editor logo, TLS proxy, real
SSO).

The manual steps below are the same work, for anyone who prefers to do it by
hand or needs to debug a failed step.

## Install by hand (run on the server, in this order)

**Step 0 — which Erlang?** Check the OS major version:

    cat /etc/redhat-release

RHEL/Rocky/Alma **8**.x → use the `el8` Erlang rpm. **9**.x → use `el9`.
(The RabbitMQ rpm itself is noarch and works on both.)

**Step 1 — Erlang, then RabbitMQ:**

    sudo dnf install ./erlang-26.2.5.2-1.el9.x86_64.rpm        # or the el8 one
    sudo dnf install ./rabbitmq-server-3.13.7-1.el8.noarch.rpm
    sudo systemctl enable --now rabbitmq-server

CHECK: `sudo rabbitmqctl status` prints a status report (not an error).

**Step 2 — PostgreSQL.** Order matters: PostgreSQL 13 (the RHEL 9 default)
stores passwords as `md5` unless told otherwise, and Document Server then
cannot log in. Set the encryption **before** creating the user:

    sudo dnf install -y postgresql-server postgresql
    sudo postgresql-setup --initdb
    sudo systemctl enable --now postgresql
    sudo -u postgres psql -c "ALTER SYSTEM SET password_encryption='scram-sha-256';"
    sudo systemctl restart postgresql
    sudo -u postgres psql -c "CREATE DATABASE onlyoffice;" -c "CREATE USER onlyoffice WITH password 'onlyoffice';" -c "GRANT ALL privileges ON DATABASE onlyoffice TO onlyoffice;"

Then allow password logins over localhost: in `/var/lib/pgsql/data/pg_hba.conf`
change `ident` to `scram-sha-256` on the two `host all all 127.0.0.1/32` and
`::1/128` lines, and restart once more:

    sudo systemctl restart postgresql

CHECK: `PGPASSWORD=onlyoffice psql -h 127.0.0.1 -U onlyoffice -d onlyoffice -c "select 1;"` → prints `1`.

(If the user already exists with an md5 password, re-hash it with
`sudo -u postgres psql -c "ALTER USER onlyoffice PASSWORD 'onlyoffice';"`
after the `ALTER SYSTEM` + restart — otherwise login fails with
"password authentication failed".)

**Step 3 — Document Server's real dependencies, then Document Server.**

    sudo dnf install -y --allowerasing nginx xorg-x11-server-Xvfb gtk3 \
      liberation-mono-fonts liberation-sans-fonts liberation-serif-fonts \
      logrotate vim-common wget curl ca-certificates alsa-lib atk \
      libXScrnSaver libXtst libselinux-utils openssl zlib libcurl libstdc++

(`--allowerasing` is needed because `libcurl` replaces `libcurl-minimal`.
This pulls in ~220 packages in total — all stock RHEL 9, no EPEL.)

    sudo rpm -ivh --nodeps ./onlyoffice-documentserver-9.4.0.x86_64.rpm

**Why `--nodeps`:** the rpm lists two dependencies that cannot be satisfied on
an offline RHEL 9 box, and neither is actually needed:

- `certbot` — lives in EPEL, and only exists to obtain public Let's Encrypt
  certificates. An internal server uses the bank's own certificate.
- `msttcore-fonts-installer` — its own dependencies (`cabextract`,
  `xorg-x11-font-utils`) are EPEL-only, and the package downloads fonts from
  SourceForge at install time, which an offline server cannot do. BMO's
  licensed fonts are copied in separately (ONPREM-DEPLOY.md Phase 8), which is
  what you want for fidelity anyway. The rpm is included in this folder only
  for sites that do have EPEL; **skip it otherwise.**

`--nodeps` skips only those two — every real dependency was installed above.

Then point Document Server at the database and RabbitMQ:

    sudo DB_HOST=localhost DB_PORT=5432 DB_TYPE=postgres DB_NAME=onlyoffice \
      DB_USER=onlyoffice DB_PWD=onlyoffice RABBITMQ_SERVER_URL=amqp://guest:guest@localhost \
      documentserver-configure.sh

CHECK: `curl -s http://localhost/healthcheck` → prints `true`.

⚠ That script prints a generated **JWT secret**. Copy it — the app needs the
same value (`ds_jwt_secret` in `webapp/.env`) or the editor will refuse to open
documents. Retrieve it any time with `documentserver-jwt-status.sh`.

**Step 4 — Node.js 22 and the app.** The default `nodejs` stream on RHEL 9 is
**Node 16, which the app cannot run on** (it uses Node's built-in SQLite).
Enable stream 22 first:

    sudo dnf module reset nodejs -y && sudo dnf module enable nodejs:22 -y
    sudo dnf install -y nodejs

CHECK: `node --version` → v22.x or higher.

Put the code in `/opt/riskgpt`, then install its four Node packages. With an
npm mirror reachable: `cd /opt/riskgpt/webapp && npm install`. **Offline**, use
the pre-built bundle from the Releases page instead:

    cd /opt/riskgpt/webapp
    tar xzf /path/to/npm-app-modules-linux.tar.gz

CHECK: `node -e "require('/opt/riskgpt/webapp/node_modules/express'); console.log('ok')"` → `ok`.

**Step 5 — PDF conversion packages (offline pip install, Python 3.14):**

The server has no internet, so pip must install from local files. Download
these **10 wheel files** from the Releases page
(https://github.com/algowizzzz/docai_v2/releases/tag/linux-server) into one folder,
e.g. `/opt/riskgpt/wheels` (verify each against `linux-server-checksums.sha256`
on the same page):

    fire-0.7.1-py3-none-any.whl
    fonttools-4.63.0-cp314-cp314-manylinux2014_x86_64.manylinux_2_17_x86_64.whl
    lxml-6.1.1-cp314-cp314-manylinux_2_26_x86_64.manylinux_2_28_x86_64.whl
    numpy-2.5.1-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl
    opencv_python_headless-5.0.0.93-cp37-abi3-manylinux_2_28_x86_64.whl
    pdf2docx-0.5.13-py3-none-any.whl
    pymupdf-1.28.2-cp310-abi3-manylinux_2_28_x86_64.whl
    python_docx-1.2.0-py3-none-any.whl
    termcolor-3.3.0-py3-none-any.whl
    typing_extensions-4.16.0-py3-none-any.whl

Then:

    cd /opt/riskgpt/webapp
    python3.14 -m venv pdfenv
    pdfenv/bin/pip install --no-index --find-links /opt/riskgpt/wheels pdf2docx

⚠ Use `python3.14`, **not** `python3` — on RHEL 9 `python3` is 3.9 and the
install fails with "Could not find a version that satisfies numpy".
Install the interpreter first with `sudo dnf install -y python3.14`.

CHECK: `pdfenv/bin/python -c "import pdf2docx; print('ok')"` → prints `ok`.
Wheels are built for **Python 3.14 on x86_64** (glibc ≥ 2.28, so RHEL 9).
A different server Python needs a different wheel set — ask.

**Step 6 — continue with the normal deployment guide:** the required
`local.json` edits (JWT secrets + private-IP allowance), systemd units for the
app, firewall and fonts are all in [ONPREM-DEPLOY.md](../ONPREM-DEPLOY.md)
(Linux section) and [HAPPY-PATH.md](../HAPPY-PATH.md).

## Version pinning

These exact versions are what the pilot was validated against (Document
Server 9.4 — same major version as the 14/14 fidelity test corpus). Do not
let the server auto-upgrade `onlyoffice-documentserver`; upgrades happen
deliberately, re-running the fidelity harness first.
