/* Session + role middleware. Identity comes from the agentic platform via
 * /sso code exchange (see AUTH-INTEGRATION.md); this module only signs and
 * verifies RiskGPT's own session cookie and gates routes by role.
 */
const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || "dev-session-secret-change-in-prod";
const COOKIE = "riskgpt_session";
const MAX_AGE_S = 8 * 3600;

const PLATFORM_LAUNCH_URL = process.env.PLATFORM_LAUNCH_URL || "http://localhost:3999/?app=riskgpt";
const PLATFORM_EXCHANGE_URL = process.env.PLATFORM_EXCHANGE_URL || "http://localhost:3999/api/sso/exchange";
const PLATFORM_CONFIG_URL = process.env.PLATFORM_CONFIG_URL || "http://localhost:3999/api/workers/{id}/config";
const PLATFORM_CLIENT_SECRET = process.env.PLATFORM_CLIENT_SECRET || "dev-client-secret";
const PLATFORM_SERVICE_TOKEN = process.env.PLATFORM_SERVICE_TOKEN || "dev-service-token";

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }
function hmac(s) { return crypto.createHmac("sha256", SECRET).update(s).digest("base64url"); }

function makeSession(claims) {
  const payload = b64url(JSON.stringify({
    sub: claims.sub, name: claims.name, role: claims.role,
    worker_id: claims.worker_id, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S
  }));
  return payload + "." + hmac(payload);
}

function readSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const val = raw.slice(COOKIE.length + 1);
  const [payload, sig] = val.split(".");
  if (!payload || !sig) return null;
  if (!crypto.timingSafeEqual(Buffer.from(hmac(payload)), Buffer.from(sig))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!s.exp || s.exp < Date.now() / 1000) return null;
    return s;
  } catch (e) { return null; }
}

function setSessionCookie(res, claims) {
  // Secure flag intentionally omitted in local dev (http); add via env in prod
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${makeSession(claims)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure}`);
}

function isAdmin(s) { return s && (s.role === "admin" || s.role === "superadmin"); }

// Paths Document Server (not the browser) fetches — no user session exists
// there by design; DS JWT covers them in production (see AUTH-INTEGRATION.md).
const OPEN_PREFIXES = ["/sso", "/files/", "/callback/", "/plugin/", "/brand/", "/healthz"];

function requireAuth(req, res, next) {
  if (OPEN_PREFIXES.some(p => req.path === p || req.path.startsWith(p))) return next();
  const s = readSession(req);
  if (s) { req.user = s; return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not authenticated" });
  res.redirect(PLATFORM_LAUNCH_URL);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req.user)) return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Admin only" });
  res.status(403).send("<h3 style='font-family:sans-serif'>403 — this page requires an admin role.</h3>");
}

// ---------- platform calls ----------
async function exchangeCode(code) {
  const r = await fetch(PLATFORM_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, client_id: "riskgpt", client_secret: PLATFORM_CLIENT_SECRET }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`exchange failed: ${r.status}`);
  return r.json();
}

const workerConfigCache = new Map();
async function getWorkerConfig(workerId) {
  if (!workerId) return {};
  if (workerConfigCache.has(workerId)) return workerConfigCache.get(workerId);
  try {
    const r = await fetch(PLATFORM_CONFIG_URL.replace("{id}", encodeURIComponent(workerId)), {
      headers: { Authorization: `Bearer ${PLATFORM_SERVICE_TOKEN}` },
      signal: AbortSignal.timeout(10000)
    });
    const cfg = r.ok ? await r.json() : {};
    workerConfigCache.set(workerId, cfg);
    return cfg;
  } catch (e) { return {}; }
}

module.exports = {
  requireAuth, requireAdmin, isAdmin, setSessionCookie, readSession,
  exchangeCode, getWorkerConfig, PLATFORM_LAUNCH_URL, PLATFORM_SERVICE_TOKEN
};
