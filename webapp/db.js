/* SQLite storage for the prompt chain module.
 * Single file at webapp/data/riskgpt.db — copy the file to move to on-prem.
 * Uses Node's built-in sqlite (node >= 22.5), no native deps.
 */
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "riskgpt.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS prompt_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('step','summary')),
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    group_name TEXT,
    doc_words INTEGER,
    output_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chat_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, user_name TEXT,
    scope TEXT, context_words INTEGER,
    question TEXT, answer TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
try { db.exec("ALTER TABLE runs ADD COLUMN user_id TEXT"); } catch (e) { /* exists */ }
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

const DEFAULT_STANDARD = {
  body: { font: "Calibri", sizePt: 11, color: "1D1D1F" },
  h1: { sizePt: 16, color: "0079C1", bold: true },
  h2: { sizePt: 14, color: "0079C1", bold: true },
  h3: { sizePt: 12, color: "00629B", bold: true },
  headerText: "{filename}",
  footerPageNumber: true,
  cellFill: "E8F0F7",
  inferH1Pt: 20, inferH2Pt: 15, inferH3Pt: 13,
  metadataTable: true,
  metadataFields: ["Document Owner", "Date", "Sponsor", "Department",
                   "Status", "Classification", "Version", "Review Date"],
  versionTable: true
};

const settings = {
  get: (key, fallback) => {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  },
  set: (key, value) =>
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value))
};

// ---------- groups ----------
const groups = {
  list: () => db.prepare(
    `SELECT g.*, (SELECT COUNT(*) FROM prompts p WHERE p.group_id = g.id AND p.type='step') AS steps,
            (SELECT COUNT(*) FROM prompts p WHERE p.group_id = g.id AND p.type='summary') AS has_summary
     FROM prompt_groups g ORDER BY g.name`).all(),
  create: name => db.prepare("INSERT INTO prompt_groups (name) VALUES (?)").run(name),
  rename: (id, name) => db.prepare("UPDATE prompt_groups SET name=? WHERE id=?").run(name, id),
  remove: id => {
    db.prepare("DELETE FROM prompts WHERE group_id=?").run(id);
    db.prepare("DELETE FROM prompt_groups WHERE id=?").run(id);
  },
  get: id => db.prepare("SELECT * FROM prompt_groups WHERE id=?").get(id)
};

// ---------- prompts ----------
const prompts = {
  forGroup: gid => db.prepare(
    "SELECT * FROM prompts WHERE group_id=? ORDER BY CASE type WHEN 'summary' THEN 0 ELSE 1 END, position").all(gid),
  steps: gid => db.prepare(
    "SELECT * FROM prompts WHERE group_id=? AND type='step' ORDER BY position").all(gid),
  summary: gid => db.prepare(
    "SELECT * FROM prompts WHERE group_id=? AND type='summary' LIMIT 1").get(gid),
  add: (gid, type, title, text) => {
    if (type === "summary" && prompts.summary(gid)) {
      throw new Error("Group already has a summary prompt");
    }
    const max = db.prepare("SELECT COALESCE(MAX(position),0) m FROM prompts WHERE group_id=? AND type='step'").get(gid).m;
    return db.prepare("INSERT INTO prompts (group_id,type,position,title,text) VALUES (?,?,?,?,?)")
      .run(gid, type, type === "step" ? max + 1 : 0, title, text);
  },
  update: (id, title, text) => db.prepare("UPDATE prompts SET title=?, text=? WHERE id=?").run(title, text, id),
  remove: id => db.prepare("DELETE FROM prompts WHERE id=?").run(id),
  // full reorder: array of prompt ids in desired order (steps only)
  reorder: (gid, ids) => {
    const stmt = db.prepare("UPDATE prompts SET position=? WHERE id=? AND group_id=? AND type='step'");
    ids.forEach((id, i) => stmt.run(i + 1, id, gid));
  }
};

// ---------- runs ----------
const runs = {
  save: (groupId, groupName, docWords, output, userId) =>
    db.prepare("INSERT INTO runs (group_id, group_name, doc_words, output_json, user_id) VALUES (?,?,?,?,?)")
      .run(groupId, groupName, docWords, JSON.stringify(output), userId || null),
  get: id => db.prepare("SELECT * FROM runs WHERE id=?").get(id)
};

db.exec(`CREATE TABLE IF NOT EXISTS std_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, user_name TEXT, doc_id TEXT,
  action TEXT, details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// node:sqlite refuses to bind undefined, and a throw here would kill the whole
// process — so every audit-log value is coerced before it reaches .run().
const txt = (v) => (v === undefined || v === null ? null : String(v));
const num = (v) => (Number.isFinite(v) ? v : 0);

const stdLog = {
  add: (u, docId, action, details) =>
    db.prepare("INSERT INTO std_log (user_id, user_name, doc_id, action, details) VALUES (?,?,?,?,?)")
      .run(txt(u?.sub), txt(u?.name), txt(docId), txt(action) ?? "", txt(details) ?? "")
};

// ---------- chat audit log (Q&A + scope; full document context is NOT stored) ----------
const chatLog = {
  add: (u, scope, words, q, a) =>
    db.prepare("INSERT INTO chat_log (user_id, user_name, scope, context_words, question, answer) VALUES (?,?,?,?,?,?)")
      .run(txt(u?.sub), txt(u?.name), txt(scope) ?? "document", num(words), txt(q) ?? "", txt(a) ?? "")
};

// ---------- seed a demo group on first boot ----------
if (groups.list().length === 0) {
  groups.create("Policy Review");
  const gid = groups.list()[0].id;
  prompts.add(gid, "step", "Purpose & scope", "Identify the purpose and scope of this document. Quote the relevant passages.");
  prompts.add(gid, "step", "Key obligations", "List every obligation, requirement, or control stated in the document.");
  prompts.add(gid, "step", "Gaps & risks", "Identify gaps, ambiguities, or risks in the document from a governance perspective.");
  prompts.add(gid, "summary", "Executive summary", "Write an executive summary of the findings below for a risk committee. Be concise.");
}

module.exports = { db, groups, prompts, runs, chatLog, stdLog, settings, DEFAULT_STANDARD };
