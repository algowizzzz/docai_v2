/* Mock agentic platform — executable spec for AUTH-INTEGRATION.md.
 * Implements: launch/login page, one-time-code SSO exchange, worker config,
 * and a mock knowledge-base chat endpoint for worker "wkr_kb".
 *
 *   node mock-platform/server.js   (port 3999)
 */
const express = require(require("path").join(__dirname, "..", "webapp", "node_modules", "express"));
const crypto = require("crypto");

const PORT = process.env.PORT || 3999;
const APP_SSO_URL = process.env.APP_SSO_URL || "http://localhost:3001/sso";
const app = express();
app.use(express.json());

const codes = new Map(); // code -> {claims, exp}

const WORKERS = {
  wkr_docs: { display_name: "Document Worker (raw LLM chat)", kb_chat_url: null },
  wkr_kb:   { display_name: "KB Worker (platform chat endpoint)", kb_chat_url: `http://localhost:${PORT}/api/kb-chat` }
};

app.get("/", (req, res) => {
  res.send(`<!doctype html><html><head><title>Mock Agentic Platform</title><style>
    body{font-family:-apple-system,sans-serif;max-width:460px;margin:8vh auto;color:#1d1d1f}
    h1{font-size:22px} .card{border:1px solid #e5e5e7;border-radius:14px;padding:22px}
    label{display:block;font-size:13px;color:#6e6e73;margin:12px 0 4px}
    input,select{width:100%;font:inherit;padding:8px;border:1px solid #d2d2d7;border-radius:8px;box-sizing:border-box}
    button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:980px;background:#0079C1;color:#fff;font:inherit;cursor:pointer}
    .hint{font-size:12px;color:#aeaeb2;margin-top:14px}
  </style></head><body>
  <h1>Mock Agentic Platform</h1>
  <div class="card">
    <form action="/launch" method="get">
      <label>Name</label><input name="name" value="Jane Doe" required>
      <label>Role</label>
      <select name="role"><option>user</option><option>admin</option><option>superadmin</option></select>
      <label>Worker</label>
      <select name="worker">
        <option value="wkr_docs">Document Worker (raw LLM chat)</option>
        <option value="wkr_kb">KB Worker (platform chat endpoint)</option>
      </select>
      <button type="submit">Open RiskGPT</button>
    </form>
    <div class="hint">Stand-in for the real platform login + worker tile. Issues a one-time code and redirects to RiskGPT /sso.</div>
  </div></body></html>`);
});

app.get("/launch", (req, res) => {
  const { name, role, worker } = req.query;
  const code = crypto.randomBytes(16).toString("hex");
  codes.set(code, {
    exp: Date.now() + 60000,
    claims: {
      sub: "u_" + crypto.createHash("md5").update(String(name)).digest("hex").slice(0, 8),
      name: String(name || "Unknown"),
      role: ["user", "admin", "superadmin"].includes(role) ? role : "user",
      worker_id: WORKERS[worker] ? worker : "wkr_docs"
    }
  });
  res.redirect(`${APP_SSO_URL}?code=${code}`);
});

app.post("/api/sso/exchange", (req, res) => {
  const { code, client_id, client_secret } = req.body || {};
  if (client_id !== "riskgpt" || client_secret !== (process.env.PLATFORM_CLIENT_SECRET || "dev-client-secret")) {
    return res.status(401).json({ error: "bad client credentials" });
  }
  const entry = codes.get(code);
  codes.delete(code); // single use
  if (!entry || entry.exp < Date.now()) return res.status(400).json({ error: "unknown, used, or expired code" });
  res.json(entry.claims);
});

app.get("/api/workers/:id/config", (req, res) => {
  if ((req.headers.authorization || "") !== `Bearer ${process.env.PLATFORM_SERVICE_TOKEN || "dev-service-token"}`) {
    return res.status(401).json({ error: "bad service token" });
  }
  res.json(WORKERS[req.params.id] || {});
});

app.post("/api/kb-chat", (req, res) => {
  const { question, scope, user_id } = req.body || {};
  res.json({
    answer: `**[Mock KB worker]** Answer for ${user_id} (scope: ${scope}) to: "${(question || "").slice(0, 120)}".\n\n- This came from the platform KB endpoint, not the raw LLM\n- Replace with the real worker chat API`,
    citations: []
  });
});

app.listen(PORT, () => console.log(`mock platform on http://localhost:${PORT}`));
