/* DocGov pilot server
 *
 * - Upload .docx  -> stored as storage/<id>/v1.docx (originals immutable)
 * - /doc/:id      -> page embedding ONLYOFFICE editor
 * - /callback/:id -> Document Server posts saved versions -> stored as v2, v3, ...
 * - /plugin/*     -> serves the chat side-panel plugin (config.json etc.)
 * - /api/ai       -> MOCK of the company AI layer; replace with a proxy to the real API
 */
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");

const PORT = process.env.PORT || 3001;
// How the *browser* reaches Document Server:
const DS_PUBLIC = process.env.DS_PUBLIC || "http://localhost:8090";
// How *Document Server* (inside Docker) reaches this app:
const APP_FOR_DS = process.env.APP_FOR_DS || `http://host.docker.internal:${process.env.PORT || 3001}`;

const STORAGE = path.join(__dirname, "storage");
fs.mkdirSync(STORAGE, { recursive: true });

const app = express();
app.use(express.json({ limit: "10mb" }));
// Document Server's editor frame (different origin) fetches the plugin files
app.use("/plugin", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
}, express.static(path.join(__dirname, "plugin")));
app.use("/brand", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
}, express.static(path.join(__dirname, "brand")));

const upload = multer({ dest: path.join(__dirname, "tmp-upload") });

// ---------- helpers ----------
function docDir(id) { return path.join(STORAGE, id); }
function versions(id) {
  return fs.readdirSync(docDir(id))
    .filter(f => /^v\d+\.docx$/.test(f))
    .map(f => parseInt(f.slice(1)))
    .sort((a, b) => a - b);
}
function latest(id) { const v = versions(id); return v[v.length - 1]; }
function meta(id) { return JSON.parse(fs.readFileSync(path.join(docDir(id), "meta.json"))); }

// ---------- upload ----------
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file || !req.file.originalname.toLowerCase().endsWith(".docx")) {
    return res.status(400).send("Only .docx files in the pilot");
  }
  const id = crypto.randomBytes(6).toString("hex");
  fs.mkdirSync(docDir(id));
  fs.copyFileSync(req.file.path, path.join(docDir(id), "v1.docx"));
  fs.unlinkSync(req.file.path);
  fs.writeFileSync(path.join(docDir(id), "meta.json"),
    JSON.stringify({ title: req.file.originalname, uploaded: new Date().toISOString() }));
  res.redirect(`/doc/${id}`);
});

// ---------- serve document files to Document Server ----------
app.get("/files/:id/v:ver.docx", (req, res) => {
  const f = path.join(docDir(req.params.id), `v${req.params.ver}.docx`);
  if (!fs.existsSync(f)) return res.sendStatus(404);
  res.download(f, meta(req.params.id).title);
});

// ---------- save callback from Document Server ----------
app.post("/callback/:id", (req, res) => {
  const { status, url } = req.body || {};
  // status 2 = ready for saving, 6 = force-save
  if ((status === 2 || status === 6) && url) {
    const id = req.params.id;
    http.get(url, r => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => {
        const buf = Buffer.concat(chunks);
        const cur = latest(id);
        const curBuf = fs.readFileSync(path.join(docDir(id), `v${cur}.docx`));
        const h = b => crypto.createHash("md5").update(b).digest("hex");
        if (h(buf) === h(curBuf)) return console.log(`${id}: content unchanged, no new version`);
        fs.writeFileSync(path.join(docDir(id), `v${cur + 1}.docx`), buf);
        console.log(`saved ${id} v${cur + 1}`);
      });
    }).on("error", e => console.error("save failed", e.message));
  }
  res.json({ error: 0 });
});

/* ---------- MOCK worker endpoints ----------
 * These mirror the real worker API contracts. Integration = replace each
 * handler body with a server-side fetch() to the real worker; keep the shapes.
 */

// 1. Document chat worker: query + doc context (full doc or highlighted selection)
app.post("/api/worker/chat", async (req, res) => {
  const { question, context, scope } = req.body || {}; // scope: "selection" | "document"
  const answer = await callLLM({
    system: "You are RiskGPT, an assistant for Bank of Montreal risk & governance staff. " +
            "Answer the user's question using the provided document " +
            (scope === "selection" ? "excerpt (the user's highlighted selection)." : "text.") +
            " Be concise and precise; quote the document where relevant.",
    input: `DOCUMENT ${scope === "selection" ? "EXCERPT" : "TEXT"}:\n${context || "(none)"}\n\nQUESTION: ${question || ""}`,
    reasoning: "medium"
  });
  res.json({ answer });
});

/* ---------- LLM call — THE single integration point ----------
 * DeepSeek (OpenAI-compatible). `reasoning` maps to the model choice:
 * "high" -> deepseek-reasoner (thinking model), otherwise deepseek-chat.
 * Falls back to a mock answer if no key is configured or the call fails.
 */
function loadEnv() {
  const out = {};
  for (const p of [path.join(__dirname, ".env"), "/Users/saadahmed/Desktop/seo/.env"]) {
    try {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m) out[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch (e) {}
  }
  return out;
}
const ENV = loadEnv();
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || ENV.deepseek_api_key || null;

async function callLLM({ system, input, reasoning = "medium" }) {
  const words = input && input.trim() ? input.trim().split(/\s+/).length : 0;
  if (!DEEPSEEK_KEY) {
    return `[MOCK LLM · reasoning=${reasoning}] ${system.slice(0, 90)}… → processed ${words} words of input.`;
  }
  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: reasoning === "high" ? "deepseek-reasoner" : "deepseek-chat",
        messages: [
          { role: "system", content: system },
          { role: "user", content: input || "(no input provided)" }
        ]
      }),
      signal: AbortSignal.timeout(120000)
    });
    if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content || "(empty response)";
  } catch (e) {
    console.error("LLM call failed:", e.message);
    return `[LLM error: ${e.message}] (mock fallback) ${system.slice(0, 60)}… → ${words} words of input.`;
  }
}

// ---------- prompt chain: groups + prompts CRUD ----------
const store = require("./db");

app.get("/api/promptgroups", (req, res) => res.json(store.groups.list()));
app.post("/api/promptgroups", (req, res) => {
  try { store.groups.create((req.body.name || "").trim()); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/promptgroups/:id", (req, res) => {
  store.groups.rename(+req.params.id, (req.body.name || "").trim()); res.json({ ok: true });
});
app.delete("/api/promptgroups/:id", (req, res) => {
  store.groups.remove(+req.params.id); res.json({ ok: true });
});
app.get("/api/promptgroups/:id/prompts", (req, res) => res.json(store.prompts.forGroup(+req.params.id)));
app.post("/api/promptgroups/:id/prompts", (req, res) => {
  const { type, title, text } = req.body || {};
  try { store.prompts.add(+req.params.id, type === "summary" ? "summary" : "step", title, text); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/prompts/:id", (req, res) => {
  store.prompts.update(+req.params.id, req.body.title, req.body.text); res.json({ ok: true });
});
app.delete("/api/prompts/:id", (req, res) => { store.prompts.remove(+req.params.id); res.json({ ok: true }); });
app.post("/api/promptgroups/:id/reorder", (req, res) => {
  store.prompts.reorder(+req.params.id, req.body.ids || []); res.json({ ok: true });
});

// ---------- prompt chain: runner ----------
// Runs every step prompt in order over the document, then the summary prompt
// (if any) over the concatenated step outputs. Summary is generated LAST but
// returned first — the UI shows it on top.
app.post("/api/worker/promptchain", async (req, res) => {
  const { groupId, document } = req.body || {};
  const group = store.groups.get(+groupId);
  if (!group) return res.status(404).json({ error: "Unknown prompt group" });
  const steps = store.prompts.steps(group.id);
  const summaryPrompt = store.prompts.summary(group.id);
  const docWords = document && document.trim() ? document.trim().split(/\s+/).length : 0;

  const stepResults = [];
  for (const p of steps) {
    const answer = await callLLM({ system: p.text, input: document || "" });
    stepResults.push({ id: p.id, title: p.title, answer });
  }
  let summary = null;
  if (summaryPrompt) {
    const combined = stepResults.map(s => `## ${s.title}\n${s.answer}`).join("\n\n");
    summary = {
      title: summaryPrompt.title,
      answer: await callLLM({ system: summaryPrompt.text, input: combined })
    };
  }
  const output = { group: group.name, summary, steps: stepResults, ranAt: new Date().toISOString() };
  const saved = store.runs.save(group.id, group.name, docWords, output);
  res.json({ runId: Number(saved.lastInsertRowid), ...output });
});

// ---------- export a run as a Word document ----------
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");

// Convert LLM markdown-ish text into docx paragraphs (headings, bullets, bold/italic)
function mdToDocxParas(text) {
  const paras = [];
  const runsOf = s => {
    const runs = [];
    // split on **bold** and *italic* segments
    const parts = s.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean);
    for (const p of parts) {
      if (/^\*\*[^*]+\*\*$/.test(p)) runs.push(new TextRun({ text: p.slice(2, -2), bold: true }));
      else if (/^\*[^*]+\*$/.test(p)) runs.push(new TextRun({ text: p.slice(1, -1), italics: true }));
      else if (/^`[^`]+`$/.test(p)) runs.push(new TextRun({ text: p.slice(1, -1), font: "Courier New" }));
      else runs.push(new TextRun(p));
    }
    return runs;
  };
  for (const raw of (text || "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
      const lvl = [HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4,
                   HeadingLevel.HEADING_5, HeadingLevel.HEADING_6, HeadingLevel.HEADING_6][m[1].length - 1];
      paras.push(new Paragraph({ heading: lvl, children: runsOf(m[2]) }));
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
      paras.push(new Paragraph({ bullet: { level: 0 }, children: runsOf(m[1]) }));
    } else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)/))) {
      paras.push(new Paragraph({ bullet: { level: 0 }, children: runsOf(`${m[1]}. `).concat(runsOf(m[2])) }));
    } else if (/^-{3,}$/.test(line.trim())) {
      continue; // horizontal rules add noise in Word
    } else {
      paras.push(new Paragraph({ children: runsOf(line) }));
    }
  }
  return paras;
}

app.get("/export/run/:id", async (req, res) => {
  const run = store.runs.get(+req.params.id);
  if (!run) return res.sendStatus(404);
  const o = JSON.parse(run.output_json);
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(`${o.group} — AI Analysis`)] }),
    new Paragraph({ children: [new TextRun({ text: `Run ${run.id} · ${run.created_at} · ${run.doc_words} words of document · BMO RiskGPT`, italics: true, color: "6E6E73" })] })
  ];
  if (o.summary) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(`${o.summary.title} (Summary)`)] }));
    children.push(...mdToDocxParas(o.summary.answer));
  }
  o.steps.forEach((s, i) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(`${i + 1}. ${s.title}`)] }));
    children.push(...mdToDocxParas(s.answer));
  });
  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${o.group.replace(/[^\w-]+/g, "_")}_analysis_run${run.id}.docx"`);
  res.send(Buffer.from(buf));
});

// ---------- shared UI ----------
const BRAND_CSS = `
  :root{
    --bmo-blue:#0079C1; --bmo-blue-dark:#00629B;
    --ink:#1d1d1f; --ink-2:#6e6e73; --ink-3:#aeaeb2;
    --bg:#f5f5f7; --card:#ffffff; --line:#e8e8ed;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;
       background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  a{color:inherit;text-decoration:none}
  .topbar{height:52px;background:var(--bmo-blue);display:flex;align-items:center;
          padding:0 24px;gap:14px;position:sticky;top:0;z-index:10}
  .wordmark{font-weight:800;font-size:17px;letter-spacing:.02em;color:#fff}
  .brandlogo{height:26px;display:block}
  .divider{width:1px;height:20px;background:rgba(255,255,255,.35)}
  .appname{font-size:14px;color:rgba(255,255,255,.92);font-weight:500}
  .spacer{flex:1}
  .btn{border:0;cursor:pointer;font:inherit;border-radius:980px;padding:7px 16px;font-size:13px;font-weight:500}
  .btn-primary{background:#fff;color:var(--bmo-blue)}
  .btn-primary:hover{background:#eaf4fb}
  .btn-quiet{background:transparent;color:#fff}
  .btn-quiet:hover{background:rgba(255,255,255,.16)}
`;
function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

// ---------- pages ----------
app.get("/", (req, res) => {
  const docs = fs.readdirSync(STORAGE)
    .filter(d => fs.existsSync(path.join(STORAGE, d, "meta.json")))
    .map(id => {
      const v = latest(id);
      const mtime = fs.statSync(path.join(docDir(id), `v${v}.docx`)).mtime;
      return { id, title: meta(id).title, v, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const rows = docs.map(d => `
    <a class="row" href="/doc/${d.id}" data-title="${d.title.toLowerCase()}">
      <svg class="ficon" viewBox="0 0 20 20" fill="none"><path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="var(--bmo-blue)" stroke-width="1.4"/><path d="M12 2v4h4" stroke="var(--bmo-blue)" stroke-width="1.4"/></svg>
      <div class="rmain">
        <div class="rtitle">${d.title}</div>
        <div class="rmeta">v${d.v} · Updated ${fmtDate(d.mtime)}</div>
      </div>
      <svg class="chev" viewBox="0 0 8 14" fill="none"><path d="M1 1l6 6-6 6" stroke="var(--ink-3)" stroke-width="1.6" stroke-linecap="round"/></svg>
    </a>`).join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Documents — BMO RiskGPT</title><style>${BRAND_CSS}
    .wrap{max-width:820px;margin:0 auto;padding:40px 24px 80px}
    h1{font-size:28px;font-weight:700;letter-spacing:-.02em;margin:0}
    .sub{color:var(--ink-2);font-size:14px;margin:6px 0 28px}
    .search{width:240px;border:1px solid var(--line);background:var(--card);border-radius:10px;
            padding:8px 12px;font:inherit;font-size:13px;color:var(--ink);outline:none}
    .search:focus{border-color:var(--bmo-blue)}
    .headrow{display:flex;align-items:flex-end;justify-content:space-between}
    .drop{margin:0 0 28px;border:1.5px dashed var(--line);border-radius:16px;background:var(--card);
          padding:34px;text-align:center;transition:all .15s ease;cursor:pointer}
    .drop.over{border-color:var(--bmo-blue);background:rgba(0,121,193,.04)}
    .drop .big{font-size:15px;font-weight:600}
    .drop .hint{color:var(--ink-2);font-size:13px;margin-top:4px}
    .drop .trust{color:var(--ink-3);font-size:12px;margin-top:12px}
    .list{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
    .row{display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--line)}
    .row:last-child{border-bottom:0}
    .row:hover{background:#fafafa}
    .ficon{width:20px;height:20px;flex:none}
    .rmain{flex:1;min-width:0}
    .rtitle{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rmeta{font-size:12px;color:var(--ink-2);margin-top:2px}
    .chev{width:8px;height:14px;flex:none}
    .empty{padding:64px 24px;text-align:center;color:var(--ink-2);font-size:14px}
    #prog{display:none;margin-top:10px;font-size:12px;color:var(--bmo-blue)}
  </style></head><body>
  <div class="topbar">
    <img class="brandlogo" src="/brand/bmo-logo.png" alt="BMO"><span class="divider"></span>
    <span class="appname">RiskGPT</span>
    <span class="spacer"></span>
    <a class="btn btn-quiet" href="/prompts">AI Analysis</a>
  </div>
  <div class="wrap">
    <div class="headrow">
      <div><h1>Documents</h1>
      <div class="sub">${docs.length} document${docs.length === 1 ? "" : "s"}</div></div>
      <input class="search" id="search" type="search" placeholder="Search">
    </div>
    <div class="drop" id="drop">
      <div class="big">Drop a Word document here</div>
      <div class="hint">or click to choose a .docx file</div>
      <div class="trust">Originals are preserved — every edit becomes a new version.</div>
      <div id="prog">Uploading…</div>
      <input id="file" type="file" accept=".docx" hidden>
    </div>
    <div class="list" id="list">${rows || '<div class="empty">No documents yet. Drop a Word file above to begin.</div>'}</div>
  </div>
  <script>
    const drop = document.getElementById("drop"), file = document.getElementById("file");
    drop.addEventListener("click", () => file.click());
    ["dragover","dragenter"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add("over"); }));
    ["dragleave","drop"].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", ev => upload(ev.dataTransfer.files[0]));
    file.addEventListener("change", () => upload(file.files[0]));
    function upload(f) {
      if (!f || !f.name.toLowerCase().endsWith(".docx")) { alert("Please choose a .docx file"); return; }
      document.getElementById("prog").style.display = "block";
      const fd = new FormData(); fd.append("file", f);
      fetch("/upload", { method: "POST", body: fd }).then(r => { window.location = r.url; });
    }
    document.getElementById("search").addEventListener("input", e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(".row").forEach(r =>
        r.style.display = r.dataset.title.includes(q) ? "" : "none");
    });
  </script>
  </body></html>`);
});

app.get("/doc/:id", (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(docDir(id))) return res.sendStatus(404);
  const m = meta(id);
  const cur = latest(id);
  // ?v=N opens an older version read-only
  const ver = req.query.v && versions(id).includes(+req.query.v) ? +req.query.v : cur;
  const readonly = ver !== cur;
  // key must change whenever the file content changes
  const fileBytes = fs.readFileSync(path.join(docDir(id), `v${ver}.docx`));
  const key = id + "_v" + ver + "_" + crypto.createHash("md5").update(fileBytes).digest("hex").slice(0, 10);
  const config = {
    documentType: "word",
    document: {
      fileType: "docx",
      key,
      title: readonly ? `${m.title} (v${ver}, read-only)` : m.title,
      url: `${APP_FOR_DS}/files/${id}/v${ver}.docx`,
      permissions: { edit: !readonly, download: true, print: true }
    },
    editorConfig: {
      mode: readonly ? "view" : "edit",
      callbackUrl: `${APP_FOR_DS}/callback/${id}`,
      lang: "en",
      user: { id: "pilot-user", name: "Pilot User" },
      customization: {
        autosave: true,
        forcesave: true,
        compactHeader: true,
        toolbarNoTabs: false,
        toolbarHideFileName: true,
        hideRightMenu: true,
        plugins: true,
        macros: false,
        help: false,
        about: false,
        feedback: false,
        logo: {
          image: `http://localhost:${PORT}/brand/riskgpt.png`,
          imageDark: `http://localhost:${PORT}/brand/riskgpt.png`,
          url: `http://localhost:${PORT}/`
        }
      },
      plugins: {
        autostart: ["asc.{8A014E8C-7C3A-4BB5-93D2-4A1D00E4B1C9}"],
        // plugin files are fetched by the BROWSER, so use the browser-facing origin
        pluginsData: [`http://localhost:${PORT}/plugin/config.json`]
      }
    },
    width: "100%",
    height: "100%"
  };
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${m.title} — BMO RiskGPT</title>
  <style>${BRAND_CSS}
    html,body{height:100%;overflow:hidden}
    body{display:flex;flex-direction:column}
    .topbar{flex:none}
    .back{display:flex;align-items:center;gap:8px;color:#fff;font-size:13px;font-weight:500}
    .doctitle{font-size:14px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
    .status{font-size:12px;color:rgba(255,255,255,.8)}
    #editor{flex:1}
  </style></head><body>
  <div class="topbar">
    <a class="back" href="/"><svg width="8" height="14" viewBox="0 0 8 14" fill="none"><path d="M7 13L1 7l6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>Documents</a>
    <span class="divider"></span>
    <span class="doctitle">${m.title}</span>
    <span class="status">${readonly ? `Viewing v${ver} (read-only)` : `v${ver} · Saved`}</span>
    <span class="spacer"></span>
    ${readonly ? `<a class="btn btn-primary" href="/doc/${id}">Back to current</a>` : ""}
    <button class="btn btn-quiet" id="histbtn">History</button>
    <a class="btn btn-quiet" href="/download/${id}${readonly ? `?v=${ver}` : ""}">Download</a>
  </div>
  <div id="editor"></div>

  <div class="scrim" id="scrim"></div>
  <div class="drawer" id="drawer">
    <div class="dhead"><span>Version history</span>
      <button class="dclose" id="histclose" aria-label="Close">&times;</button></div>
    <div class="dbody" id="dbody"></div>
    <div class="dfoot">Restore never overwrites — it creates a new version from the one you pick.</div>
  </div>
  <style>
    .scrim{display:none;position:fixed;inset:0;background:rgba(0,0,0,.18);z-index:40}
    .drawer{position:fixed;top:0;right:-360px;width:340px;height:100%;background:var(--card);
            z-index:50;border-left:1px solid var(--line);display:flex;flex-direction:column;
            transition:right .22s ease;box-shadow:-12px 0 32px rgba(0,0,0,.06)}
    .drawer.open{right:0}.scrim.show{display:block}
    .dhead{display:flex;align-items:center;justify-content:space-between;
           padding:16px 18px;font-size:15px;font-weight:600;border-bottom:1px solid var(--line)}
    .dclose{border:0;background:none;font-size:22px;color:var(--ink-2);cursor:pointer;line-height:1}
    .dbody{flex:1;overflow-y:auto;padding:8px 0}
    .vrow{padding:12px 18px;border-bottom:1px solid var(--line)}
    .vrow .vtop{display:flex;align-items:baseline;gap:8px}
    .vnum{font-size:14px;font-weight:600}
    .vtag{font-size:11px;color:var(--bmo-blue);background:rgba(0,121,193,.09);
          border-radius:980px;padding:2px 9px;font-weight:500}
    .vdate{font-size:12px;color:var(--ink-2);margin-top:2px}
    .vact{margin-top:8px;display:flex;gap:6px}
    .vact .btn{padding:4px 12px;font-size:12px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
    .vact .btn:hover{border-color:var(--bmo-blue);color:var(--bmo-blue)}
    .dfoot{padding:12px 18px;font-size:11px;color:var(--ink-3);border-top:1px solid var(--line)}
  </style>
  <script>
    const drawer = document.getElementById("drawer"), scrim = document.getElementById("scrim");
    function closeDrawer(){ drawer.classList.remove("open"); scrim.classList.remove("show"); }
    document.getElementById("histclose").onclick = closeDrawer;
    scrim.onclick = closeDrawer;
    document.getElementById("histbtn").onclick = async () => {
      const vs = await fetch("/api/versions/${id}").then(r => r.json());
      document.getElementById("dbody").innerHTML = vs.map(x => \`
        <div class="vrow">
          <div class="vtop"><span class="vnum">Version \${x.v}</span>
            \${x.current ? '<span class="vtag">Current</span>' : ''}
            \${x.original ? '<span class="vtag">Original upload</span>' : ''}</div>
          <div class="vdate">\${new Date(x.date).toLocaleString("en-CA",{dateStyle:"medium",timeStyle:"short"})}</div>
          <div class="vact">
            \${x.current ? '' : \`<a class="btn" href="/doc/${id}?v=\${x.v}">View</a>\`}
            <a class="btn" href="/download/${id}?v=\${x.v}">Download</a>
            \${x.current ? '' : \`<button class="btn" onclick="restoreV(\${x.v})">Restore</button>\`}
          </div>
        </div>\`).join("");
      drawer.classList.add("open"); scrim.classList.add("show");
    };
    async function restoreV(v) {
      if (!confirm("Restore version " + v + "? The current version stays in history; v" + v + " becomes a new version.")) return;
      await fetch("/restore/${id}/" + v, { method: "POST" });
      window.location = "/doc/${id}";
    }
  </script>
  <script src="${DS_PUBLIC}/web-apps/apps/api/documents/api.js"></script>
  <script>new DocsAPI.DocEditor("editor", ${JSON.stringify(config)});</script>
  </body></html>`);
});

// ---------- prompts admin page ----------
app.get("/prompts", (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AI Analysis — BMO RiskGPT</title><style>${BRAND_CSS}
    .wrap{max-width:980px;margin:0 auto;padding:36px 24px 80px;display:flex;gap:24px;align-items:flex-start}
    h1{font-size:24px;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
    .col-g{width:300px;flex:none}
    .col-p{flex:1;min-width:0}
    .card{background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden}
    .g-row{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);cursor:pointer}
    .g-row:last-child{border-bottom:0}
    .g-row:hover{background:#fafafa}
    .g-row.sel{background:rgba(0,121,193,.07)}
    .g-name{flex:1;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .g-meta{font-size:11px;color:var(--ink-2)}
    .mini{border:1px solid var(--line);background:var(--card);border-radius:980px;font-size:11px;
          padding:3px 10px;cursor:pointer;color:var(--ink-2)}
    .mini:hover{border-color:var(--bmo-blue);color:var(--bmo-blue)}
    .mini.danger:hover{border-color:#C00000;color:#C00000}
    .p-row{padding:14px 18px;border-bottom:1px solid var(--line)}
    .p-row:last-child{border-bottom:0}
    .p-head{display:flex;align-items:center;gap:8px}
    .p-title{flex:1;font-size:14px;font-weight:600}
    .p-tag{font-size:10.5px;font-weight:600;border-radius:980px;padding:2px 9px;
           background:rgba(0,121,193,.1);color:var(--bmo-blue);text-transform:uppercase;letter-spacing:.04em}
    .p-text{font-size:13px;color:var(--ink-2);margin-top:6px;white-space:pre-wrap}
    .p-num{font-size:12px;color:var(--ink-3);font-weight:600;width:18px}
    .addbar{padding:14px 18px;background:#fafafa}
    input[type=text],textarea{width:100%;font:inherit;font-size:13px;border:1px solid var(--line);
      border-radius:9px;padding:8px 10px;outline:none;background:var(--card)}
    input[type=text]:focus,textarea:focus{border-color:var(--bmo-blue)}
    textarea{resize:vertical;min-height:64px;margin-top:8px}
    .formrow{display:flex;gap:8px;margin-top:8px;align-items:center}
    .btn-blue{background:var(--bmo-blue);color:#fff;border:0;border-radius:980px;
              padding:7px 16px;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
    .btn-blue:hover{background:var(--bmo-blue-dark)}
    select{font:inherit;font-size:13px;padding:7px 9px;border:1px solid var(--line);border-radius:9px;background:var(--card)}
    .sub{color:var(--ink-2);font-size:13px;margin:2px 0 20px}
    .empty{padding:40px;text-align:center;color:var(--ink-2);font-size:13px}
  </style></head><body>
  <div class="topbar">
    <a href="/"><img class="brandlogo" src="/brand/bmo-logo.png" alt="BMO"></a><span class="divider"></span>
    <span class="appname">RiskGPT</span>
    <span class="spacer"></span>
    <a class="btn btn-quiet" href="/">Documents</a>
  </div>
  <div class="wrap">
    <div class="col-g">
      <h1>AI Analysis</h1>
      <div class="sub">Each prompt group is an analysis type in the editor's AI&nbsp;Analysis tab.</div>
      <div class="card" id="glist"></div>
      <div class="formrow">
        <input type="text" id="gname" placeholder="New group name">
        <button class="btn-blue" onclick="createGroup()">Create</button>
      </div>
    </div>
    <div class="col-p" id="pcol" style="display:none">
      <h1 id="ptitle"></h1>
      <div class="sub">Steps run in order over the document. The summary prompt runs last over all step outputs and is shown first.</div>
      <div class="card" id="plist"></div>
      <div class="card addbar" style="margin-top:16px;border-radius:16px">
        <div class="formrow" style="margin-top:0">
          <select id="ntype"><option value="step">Step prompt</option><option value="summary">Summary prompt</option></select>
          <input type="text" id="ntitle" placeholder="Prompt title">
        </div>
        <textarea id="ntext" placeholder="Prompt text sent to the model…"></textarea>
        <div class="formrow"><span style="flex:1"></span><button class="btn-blue" onclick="addPrompt()">Add prompt</button></div>
      </div>
    </div>
  </div>
  <script>
    let groups = [], sel = null, prompts = [], editing = null;
    const $ = id => document.getElementById(id);
    async function j(url, opts) {
      const r = await fetch(url, opts ? Object.assign({headers:{"Content-Type":"application/json"}}, opts) : undefined);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { alert(body.error || "Request failed"); throw new Error(body.error); }
      return body;
    }
    async function loadGroups(keepSel) {
      groups = await j("/api/promptgroups");
      if (!keepSel) sel = sel && groups.find(g => g.id === sel) ? sel : (groups[0] && groups[0].id);
      $("glist").innerHTML = groups.map(g => \`
        <div class="g-row \${g.id === sel ? "sel" : ""}" onclick="pick(\${g.id})">
          <div style="flex:1;min-width:0"><div class="g-name">\${g.name}</div>
          <div class="g-meta">\${g.steps} step\${g.steps === 1 ? "" : "s"}\${g.has_summary ? " + summary" : ""}</div></div>
          <button class="mini" onclick="event.stopPropagation();renameGroup(\${g.id})">Rename</button>
          <button class="mini danger" onclick="event.stopPropagation();deleteGroup(\${g.id})">Delete</button>
        </div>\`).join("") || '<div class="empty">No prompt groups yet.</div>';
      if (sel) loadPrompts(); else $("pcol").style.display = "none";
    }
    function pick(id){ sel = id; loadGroups(true); }
    async function loadPrompts() {
      const g = groups.find(x => x.id === sel);
      if (!g) return;
      $("pcol").style.display = "block";
      $("ptitle").textContent = g.name;
      prompts = await j(\`/api/promptgroups/\${sel}/prompts\`);
      const steps = prompts.filter(p => p.type === "step");
      $("plist").innerHTML = prompts.map(p => {
        const i = steps.indexOf(p);
        if (p.id === editing) {
          return \`<div class="p-row">
            <div class="p-head">
              <span class="p-num">\${p.type === "summary" ? "★" : i + 1}</span>
              <input type="text" id="et-\${p.id}" value="\${p.title.replace(/"/g,'&quot;')}" style="flex:1">
            </div>
            <textarea id="ex-\${p.id}">\${p.text}</textarea>
            <div class="formrow"><span style="flex:1"></span>
              <button class="mini" onclick="editing=null;loadPrompts()">Cancel</button>
              <button class="btn-blue" onclick="savePrompt(\${p.id})">Save</button>
            </div>
          </div>\`;
        }
        return \`<div class="p-row">
          <div class="p-head">
            <span class="p-num">\${p.type === "summary" ? "★" : i + 1}</span>
            <span class="p-title">\${p.title}</span>
            \${p.type === "summary" ? '<span class="p-tag">Summary</span>' : \`
              <button class="mini" \${i === 0 ? "disabled" : ""} onclick="move(\${p.id},-1)">↑</button>
              <button class="mini" \${i === steps.length - 1 ? "disabled" : ""} onclick="move(\${p.id},1)">↓</button>\`}
            <button class="mini" onclick="editing=\${p.id};loadPrompts()">Edit</button>
            <button class="mini danger" onclick="delPrompt(\${p.id})">Remove</button>
          </div>
          <div class="p-text" id="ptext-\${p.id}">\${p.text}</div>
        </div>\`;
      }).join("") || '<div class="empty">No prompts yet — add the first one below.</div>';
    }
    async function createGroup() {
      const name = $("gname").value.trim(); if (!name) return;
      await j("/api/promptgroups", { method: "POST", body: JSON.stringify({ name }) });
      $("gname").value = ""; loadGroups();
    }
    async function renameGroup(id) {
      const g = groups.find(x => x.id === id);
      const name = prompt("Rename group:", g.name); if (!name) return;
      await j(\`/api/promptgroups/\${id}\`, { method: "PUT", body: JSON.stringify({ name }) }); loadGroups(true);
    }
    async function deleteGroup(id) {
      const g = groups.find(x => x.id === id);
      if (!confirm(\`Delete group “\${g.name}” and all its prompts?\`)) return;
      await j(\`/api/promptgroups/\${id}\`, { method: "DELETE" });
      if (sel === id) sel = null;
      loadGroups();
    }
    async function addPrompt() {
      const title = $("ntitle").value.trim(), text = $("ntext").value.trim();
      if (!title || !text) return alert("Title and prompt text are required");
      await j(\`/api/promptgroups/\${sel}/prompts\`, { method: "POST",
        body: JSON.stringify({ type: $("ntype").value, title, text }) });
      $("ntitle").value = ""; $("ntext").value = ""; loadGroups(true);
    }
    async function savePrompt(id) {
      const title = $("et-" + id).value.trim(), text = $("ex-" + id).value.trim();
      if (!title || !text) return alert("Title and prompt text are required");
      await j(\`/api/prompts/\${id}\`, { method: "PUT", body: JSON.stringify({ title, text }) });
      editing = null; loadGroups(true);
    }
    async function delPrompt(id) {
      if (!confirm("Remove this prompt?")) return;
      await j(\`/api/prompts/\${id}\`, { method: "DELETE" }); loadGroups(true);
    }
    async function move(id, dir) {
      const steps = prompts.filter(p => p.type === "step").map(p => p.id);
      const i = steps.indexOf(id);
      const t = i + dir; if (t < 0 || t >= steps.length) return;
      [steps[i], steps[t]] = [steps[t], steps[i]];
      await j(\`/api/promptgroups/\${sel}/reorder\`, { method: "POST", body: JSON.stringify({ ids: steps }) });
      loadGroups(true);
    }
    loadGroups();
  </script>
  </body></html>`);
});

app.get("/download/:id", (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(docDir(id))) return res.sendStatus(404);
  const ver = req.query.v && versions(id).includes(+req.query.v) ? +req.query.v : latest(id);
  const m = meta(id);
  const name = ver === latest(id) ? m.title : m.title.replace(/\.docx$/i, ` (v${ver}).docx`);
  res.download(path.join(docDir(id), `v${ver}.docx`), name);
});

// ---------- version history ----------
app.get("/api/versions/:id", (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(docDir(id))) return res.sendStatus(404);
  const cur = latest(id);
  res.json(versions(id).map(v => ({
    v,
    current: v === cur,
    original: v === 1,
    date: fs.statSync(path.join(docDir(id), `v${v}.docx`)).mtime
  })).reverse());
});

// Restore never overwrites: it copies vN forward as a NEW latest version.
app.post("/restore/:id/:ver", (req, res) => {
  const id = req.params.id, ver = +req.params.ver;
  if (!fs.existsSync(docDir(id)) || !versions(id).includes(ver)) return res.sendStatus(404);
  const next = latest(id) + 1;
  fs.copyFileSync(path.join(docDir(id), `v${ver}.docx`), path.join(docDir(id), `v${next}.docx`));
  res.json({ ok: true, newVersion: next });
});

app.listen(PORT, () => console.log(`DocGov pilot on http://localhost:${PORT}`));
