# Running without local admin — what works, what doesn't

Context: on the BMO laptop the Document Server `.exe` cannot be installed
because UAC/admin is unavailable. This file records what was tested and the
two paths that actually work.

## The hard finding (please read before spending more time)

**ONLYOFFICE Document Server cannot be made portable.** Its Windows installer
is a Delphi self-extractor whose payload is a proprietary `zlb` archive — it
does not open with 7-Zip, innoextract, or any standard tool (verified). Even
if it did, Document Server needs PostgreSQL, RabbitMQ, and nginx running and
registers Windows services; assembling that by hand is days of work with no
support path.

Erlang + RabbitMQ portable (what the current attempt is doing) makes sense as
**infrastructure for something else** — but on its own it does NOT give you
Document Server, which is the actual Word engine RiskGPT needs. Getting
Erlang and RabbitMQ running is not "most of the way there".

## Assets provided anyway (on the `deps` release)

Because they are genuinely useful and were blocked by the proxy:

| File | What it is |
|---|---|
| `erlang-otp-portable.zip` | Erlang/OTP 26.2.5, **extracted from the official installer without installing it** — no admin, no registry. Contains PORTABLE-README.txt with setup + a CHECK. |
| `rabbitmq-server-windows-3.13.7.zip` | Official RabbitMQ portable zip, mirrored for proxy reasons. |

Erlang quick start (no admin):
1. extract to `%USERPROFILE%\erlang`
2. run `Install.exe -s` **inside that folder** (Erlang's own tool, writes only there)
3. `set ERLANG_HOME=%USERPROFILE%\erlang`
4. CHECK: `%ERLANG_HOME%\bin\erl.exe -eval "erlang:display(ok), halt()." -noshell` → `ok`

## Path A (recommended) — Document Server on a machine that HAS admin

RiskGPT does not care where Document Server runs, only that the browser and
the app can reach it over HTTP. So:

- Install Document Server on any approved server/VM/colleague machine where
  admin exists (or ask IT for a one-off elevated install on the laptop).
- On the laptop run only the Node app + mock platform (no admin needed at all).
- Point the app at the remote Document Server:

      set DS_PUBLIC=http://DSHOST:80          (browser -> Document Server)
      set APP_FOR_DS=http://YOURLAPTOP:3001   (Document Server -> app)

  Both machines must reach each other; `APP_FOR_DS` must be your laptop's
  network name/IP, not `localhost`.
- Everything else in BMO-AGENT-SETUP.md is unchanged.

## Path B — full app WITHOUT Document Server (degraded, admin-free)

Everything except live Word editing works with no admin whatsoever:
upload, library, versioning, delete/restore, AI chat, AI Analysis prompt
chains, Word export, PDF→Word conversion (pdf2docx is pure Python).

What breaks: the in-browser editor page (it embeds Document Server), and
Standardize (it runs inside the editor).

This is a legitimate demo mode for showing the AI/governance features while
the Document Server approval is pending. Nothing to configure — just skip
Phases 1.3/2 of the runbook; the editor page will show its error overlay.

## What to tell IT (the actual ask)

"One elevated install of a signed, open-source (AGPL-3.0) Windows package —
ONLYOFFICE Docs Community Edition — either on my laptop once, or on a server
I can reach on port 80. No other admin rights needed; the rest of the stack
runs entirely in my user profile."

That single sentence is the whole blocker. Erlang/RabbitMQ portability does
not remove it.
