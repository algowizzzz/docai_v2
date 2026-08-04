# RiskGPT ↔ Agentic Platform — auth & connectivity contract

Audience: the team building the agentic platform (the auth authority).
RiskGPT (this app) never authenticates users itself — it consumes identity
from the platform and enforces roles locally.

## Roles

| Role | Sees |
|---|---|
| `user` | Document library (own documents only), editor, AI Assistant panel |
| `admin` / `superadmin` | Everything above + `/prompts` (AI Analysis prompt-group management) + all documents |

Enforcement is server-side middleware on every route and API, not UI hiding.

## Flow (authorization-code style)

```
agentic platform                         RiskGPT app
────────────────                         ───────────
user clicks worker
  └─ 302 → riskgpt/sso?code=<one-time>
                                         POST platform /api/sso/exchange {code}
                                         ← claims (below)
                                         set own session cookie (HttpOnly, 8h)
                                         302 → /
direct unauthenticated visit             302 → PLATFORM_LAUNCH_URL
```

Why code exchange, not a JWT in the URL: URLs land in logs and browser
history; the code is one-time and useless after exchange. (If you prefer a
short-TTL signed JWT in the redirect for v1, RiskGPT can verify it with a
shared secret — say so and we flip a config flag.)

## Contract 1 — code exchange

`POST {PLATFORM}/api/sso/exchange`
Request: `{ "code": "<one-time code>", "client_id": "riskgpt", "client_secret": "<service secret>" }`
Response `200`:

```json
{
  "sub": "u_12345",              // REQUIRED stable user id (attribution: versions, runs, chat log)
  "name": "Jane Doe",            // REQUIRED display name (shown in editor)
  "email": "jane@bmo.com",       // optional
  "role": "user",                // REQUIRED: user | admin | superadmin
  "worker_id": "wkr_abc",        // REQUIRED: worker that granted access
  "exp": 1712345738              // optional absolute expiry for the session hint
}
```

Errors: `400` unknown/used/expired code. Codes must be single-use, TTL ≤ 60s.

## Contract 2 — worker config (server-to-server, optional)

`GET {PLATFORM}/api/workers/{worker_id}/config`
Header: `Authorization: Bearer <PLATFORM_SERVICE_TOKEN>`
Response:

```json
{
  "display_name": "Credit Policy Worker",
  "kb_chat_url": "https://platform/api/workers/wkr_abc/chat",  // null → RiskGPT uses its own LLM
  "prompts_admin": false                                        // optional explicit grant overriding role
}
```

RiskGPT fetches this lazily per worker and caches it in memory. Endpoints and
secrets never reach the browser.

## Contract 3 — knowledge-base chat endpoint (optional, per worker)

When `kb_chat_url` is set, RiskGPT proxies panel chat to it instead of the
raw LLM:

`POST {kb_chat_url}` — header `Authorization: Bearer <PLATFORM_SERVICE_TOKEN>`

```json
{
  "question": "…",
  "context": "…",                 // highlighted selection or full document text
  "scope": "selection | document",
  "user_id": "u_12345",
  "worker_id": "wkr_abc"
}
```

Response: `{ "answer": "markdown supported", "citations": [] }` (citations optional,
ignored for now). Timeout budget on our side: 120s.

## Config RiskGPT needs from you (env vars)

| Var | Meaning | Example |
|---|---|---|
| `PLATFORM_LAUNCH_URL` | Where unauthenticated visitors are redirected | `https://platform/launch?app=riskgpt` |
| `PLATFORM_EXCHANGE_URL` | Code-exchange endpoint | `https://platform/api/sso/exchange` |
| `PLATFORM_CONFIG_URL` | Worker config, `{id}` placeholder | `https://platform/api/workers/{id}/config` |
| `PLATFORM_CLIENT_SECRET` | Our client secret for the exchange | — |
| `PLATFORM_SERVICE_TOKEN` | Bearer for config + KB calls | — |
| `SESSION_SECRET` | RiskGPT's own cookie-signing secret | — |

## What RiskGPT stores per user (all server-side)

- Documents: `owner {id,name}` on upload; library and document routes filter
  by owner (admins see all). Versions carry the acting user via the editor.
- Analysis runs: `user_id` recorded per run (audit).
- Chat: question + answer + scope + user + timestamp in `chat_log` (audit;
  full document context is NOT stored).
- Nothing sensitive in the browser: session is an opaque signed cookie.

## Local development / testing without the platform

`mock-platform/` in this repo is a stand-in implementing all three contracts
(login page with role & worker picker, code exchange, worker config incl. one
worker with a mock KB endpoint). Run `node mock-platform/server.js` (:3999)
and the default env values in the app point at it. The platform team can also
use it as an executable spec.

## Security notes / prod checklist

- Enable JWT between RiskGPT and ONLYOFFICE Document Server (`/files` and
  `/callback` are fetched by Document Server without a user session — DS JWT
  is what closes that path in production).
- HTTPS everywhere; `Secure` flag on the session cookie.
- Codes single-use; clock skew ≤ 30s tolerated on `exp`.
