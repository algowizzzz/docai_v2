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
| `msttcore-fonts-installer-2.6-1.noarch.rpm` | Microsoft core fonts installer — a hard rpm dependency of Document Server that is also usually absent from corporate repos | 30 KB | downloads.sourceforge.net/project/mscorefonts2 |
| `onlyoffice-documentserver-9.4.0.x86_64.rpm` | ONLYOFFICE Document Server 9.4.0 (AGPL Community Edition) | **674 MB — too big for git (GitHub hard-rejects files over 100 MB), so download it from this repo's Releases page:** https://github.com/algowizzzz/docai_v2/releases/tag/linux-server | download.onlyoffice.com/repo/centos/main/noarch/ |

SHA-256 for every file is in [`checksums.sha256`](checksums.sha256). Verify after download:

    sha256sum -c checksums.sha256

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

## Install (run on the server, in this order)

**Step 0 — which Erlang?** Check the OS major version:

    cat /etc/redhat-release

RHEL/Rocky/Alma **8**.x → use the `el8` Erlang rpm. **9**.x → use `el9`.
(The RabbitMQ rpm itself is noarch and works on both.)

**Step 1 — Erlang, then RabbitMQ:**

    sudo dnf install ./erlang-26.2.5.2-1.el9.x86_64.rpm        # or the el8 one
    sudo dnf install ./rabbitmq-server-3.13.7-1.el8.noarch.rpm
    sudo systemctl enable --now rabbitmq-server

CHECK: `sudo rabbitmqctl status` prints a status report (not an error).

**Step 2 — PostgreSQL** (Document Server needs it; it IS in the standard RHEL
AppStream repo, so the team should have it):

    sudo dnf install postgresql-server postgresql
    sudo postgresql-setup --initdb
    sudo systemctl enable --now postgresql
    sudo -i -u postgres psql -c "CREATE DATABASE onlyoffice;" -c "CREATE USER onlyoffice WITH password 'onlyoffice';" -c "GRANT ALL privileges ON DATABASE onlyoffice TO onlyoffice;"

RHEL's default PostgreSQL auth rejects password logins from localhost. Edit
`/var/lib/pgsql/data/pg_hba.conf` and change the method on the two
`host … 127.0.0.1/32 …` / `::1/128` lines from `ident` to `scram-sha-256`,
then `sudo systemctl restart postgresql`.
CHECK: `PGPASSWORD=onlyoffice psql -h 127.0.0.1 -U onlyoffice -d onlyoffice -c "select 1;"` → prints `1`.

**Step 3 — fonts dependency, then Document Server:**

    sudo dnf install ./msttcore-fonts-installer-2.6-1.noarch.rpm
    sudo dnf install ./onlyoffice-documentserver-9.4.0.x86_64.rpm

Notes for the team:

- The fonts installer downloads font files from SourceForge during install.
  If the server has no internet, install it with
  `sudo rpm -ivh --noscripts msttcore-fonts-installer-2.6-1.noarch.rpm`
  (satisfies the dependency; we load the bank's licensed fonts separately
  anyway — see ONPREM-DEPLOY.md Phase 8).
- Document Server's rpm also pulls these from the **standard RHEL/EPEL
  repos**: `nginx`, `certbot` (EPEL), `xorg-x11-server-Xvfb`, `gtk3`,
  `liberation-mono-fonts`, `logrotate`, `vim-common`, `wget`. If EPEL is not
  enabled and `certbot` blocks the install, `sudo dnf install --nobest` won't
  help — either enable the org's EPEL mirror or install with
  `sudo rpm -ivh --nodeps` **after** manually installing nginx and Xvfb
  (certbot itself is only used for public Let's Encrypt certificates, which
  an internal server doesn't need).
- If the installer asks for database settings: host `localhost`, database
  `onlyoffice`, user `onlyoffice`, password `onlyoffice`. If it never asks
  and the healthcheck below fails, run `sudo documentserver-configure.sh`.

CHECK: `curl -s http://localhost/healthcheck` → prints `true`.

**Step 4 — PDF conversion packages (offline pip install, Python 3.14):**

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
    python3 -m venv pdfenv
    pdfenv/bin/pip install --no-index --find-links /opt/riskgpt/wheels pdf2docx

CHECK: `pdfenv/bin/python -c "import pdf2docx; print('ok')"` → prints `ok`.
Wheels are built for **Python 3.14 on x86_64** (RHEL 8/9 compatible,
glibc ≥ 2.28). A different server Python needs a different wheel set — ask.

**Step 5 — continue with the normal deployment guide:** the required
`local.json` edits (JWT secrets + private-IP allowance), systemd units for the
app, firewall and fonts are all in [ONPREM-DEPLOY.md](../ONPREM-DEPLOY.md)
(Linux section) and [HAPPY-PATH.md](../HAPPY-PATH.md).

## Version pinning

These exact versions are what the pilot was validated against (Document
Server 9.4 — same major version as the 14/14 fidelity test corpus). Do not
let the server auto-upgrade `onlyoffice-documentserver`; upgrades happen
deliberately, re-running the fidelity harness first.
