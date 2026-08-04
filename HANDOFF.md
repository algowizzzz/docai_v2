# BMO Document Workspace — pilot handoff

State: working pilot, everything below verified in browser on 2026-08-03.

## Run it

```bash
docker start onlyoffice-pilot          # Document Server on :8090
cd ~/Desktop/onlyoffice-pilot/webapp && PORT=3001 node server.js   # app on :3001
```

Open http://localhost:3001 → upload .docx → edit → History drawer for versions.
(For a clean machine: `docker compose up -d` in `webapp/` builds both services.)

## What's built

- **Library** (`GET /`): BMO-branded, Apple-minimal. Drag-drop upload, search,
  doc list sorted by last edit.
- **Editor** (`GET /doc/:id`): embedded ONLYOFFICE, branded top bar, right panel
  hidden by default, ONLYOFFICE's bundled AI plugin removed (moved to
  `/root/disabled-plugins` inside the container — for compose deployments,
  mount an empty volume over that plugin path or bake removal into an image).
- **Versioning**: upload = immutable v1; every editor save = v2, v3… via
  callback. History drawer: view any version read-only (`/doc/:id?v=N`),
  download any version, restore-as-new-version (never overwrites).
- **AI Assistant panel** (`webapp/plugin/`): autoloads for every user, context
  selector (none / selection / whole doc), insert-into-document at cursor.
- **Fidelity evidence**: `reports/report.md` — 14/14 docs identical through
  round-trip (structure, text, every rendered page). Rerun any time with
  `python3 harness/fidelity_test.py` (needs the :8901 file server, see README).

## Your part: wiring the real workers (the panel's API connections)

The panel has two tabs (Chat / Prompt chain) speaking TWO worker contracts.
All are same-origin mocks in `webapp/server.js` — replace each handler body
with a server-side fetch() to the real worker; the panel needs no changes.
Keep them as server-side proxies (credentials stay out of the browser, no CORS).

1. **Chat worker** (single worker; context is automatic — the user's highlighted
   selection if any, otherwise the full document text; a live chip in the panel
   shows which one, and each sent message records it) — `POST /api/worker/chat`
   ```json
   { "question": "...", "context": "<highlighted selection OR full doc text>", "scope": "selection|document" }
   ```
   → `{ "answer": "..." }`

2. **Prompt chain module** (SQLite-backed, admin UI at `/prompts`):
   - DB: `webapp/data/riskgpt.db` (groups, prompts, runs). Copy the file to
     move everything to the on-prem server.
   - Groups CRUD: `GET/POST /api/promptgroups`, `PUT/DELETE /api/promptgroups/:id`
   - Prompts: `GET/POST /api/promptgroups/:id/prompts`, `PUT/DELETE /api/prompts/:id`,
     `POST /api/promptgroups/:id/reorder` (step ids in order). One summary
     prompt max per group (enforced).
   - Run: `POST /api/worker/promptchain` `{groupId, document}` → runs each step
     prompt in order over the document, then the summary prompt over the
     concatenated step outputs. Returns `{runId, summary, steps[]}` — summary
     generated last, returned first (UI shows it on top). Runs are persisted.
   - Export: `GET /export/run/:id` → markdown download.

## LLM integration (DeepSeek — WIRED)

`callLLM({system, input, reasoning})` in server.js is the single LLM entry
point, used by both the chat worker and the chain runner. It calls DeepSeek's
OpenAI-compatible API; `reasoning: "high"` routes to `deepseek-reasoner`,
anything else to `deepseek-chat`. Key is read from `DEEPSEEK_API_KEY` env or
`deepseek_api_key` in `.env` (webapp/.env or the seo project .env). If the key
is missing or a call fails, it degrades to a labeled mock answer instead of
erroring — check server logs for `LLM call failed`.

Status 2026-08-03: key authenticates but the DeepSeek account returned
402 Insufficient Balance — top up the account and it works with no code change.

**`webapp/plugin/code.js`** — only if you want richer behaviors:
   - `getSelection()` / `getWholeDoc()` — how document context is captured
   - `insertIntoDoc()` — currently `PasteText` at cursor; for governance,
     consider a tracked change or `AddComment` instead.

## Production checklist (unchanged, still required before real users)

1. `JWT_ENABLED=true` + secret on Document Server; sign editor configs in server.js
2. Re-enable the private-IP request filter (pilot disabled it: `local.json` →
   `request-filtering-agent.allowPrivateIPAddress` back to false; then use a
   proper hostname for the app)
3. Auth in the app (SSO), user identity in editor config + audit log
4. Corporate fonts installed on Document Server (`webapp/fonts/` mount is wired
   in compose) — then rerun the fidelity harness on real BMO docs
5. Official BMO logo SVG from the brand portal (currently a text wordmark)
6. HTTPS everywhere; storage backup; a dedicated VM (this Mac's Docker had a
   disk-full incident mid-pilot — keep headroom)

## Known limits (documented, accepted for pilot)

- PDF input: out of scope (view-only or labeled conversion later)
- SmartArt: survives untouched round-trips (proven); editing a diagram converts
  it to shapes — document as a limitation
- Legacy .doc, tracked-changes-heavy docs: not yet in the test sample
