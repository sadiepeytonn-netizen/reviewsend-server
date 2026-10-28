// Tests that the OLD app keeps working while LEGACY_MODE=true (during the switch-over).
// Tests for who can call what. Runs the real server against a small fake
// Supabase (in memory) and a fake Twilio, so nothing real is touched.
//   npm test

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");

// ── Fake Twilio ──────────────────────────────────────────────────────────────
const sentTexts = [];
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "twilio") {
    return () => ({ messages: { create: async (msg) => { sentTexts.push(msg); return { sid: "SM" + sentTexts.length }; } } });
  }
  return realLoad.call(this, request, ...rest);
};

// ── Fake Supabase ────────────────────────────────────────────────────────────
const db = {
  app_admins: [{ email: "bentonisaiah03@gmail.com" }],
  marketing_companies: [{ id: "mc1", email: "MC1@test.com" }, { id: "mc2", email: "mc2@test.com" }],
  account_managers: [{ id: "am1", email: "am1@test.com", marketing_company_id: "mc1" }],
  businesses: [
    { id: "bizA", email: "a@test.com", name: "Biz A", marketing_company_id: "mc1", account_manager_id: "am1", logo_url: "https://cdn/logoA.png", google_account_id: "accounts/1", google_location_id: "accounts/1/locations/9" },
    { id: "bizB", email: "b@test.com", name: "Biz B", marketing_company_id: "mc1", account_manager_id: null, logo_url: null },
    { id: "bizC", email: "c@test.com", name: "Biz C", marketing_company_id: "mc2", account_manager_id: null, logo_url: null },
  ],
  employees: [{ id: "e1", business_id: "bizA", email: "emp_a@test.com", name: "Emp A", password: "oldpass1", businesses: { id: "bizA", name: "Biz A" } }],
  business_google_tokens: [],
};
const authUsers = [{ id: "authB", email: "b@test.com" }]; // client B already has a login
const sessions = {}; // token -> email
let nextId = 1;

function matches(row, params) {
  for (const [col, raw] of params) {
    if (["select", "on_conflict", "page", "per_page"].includes(col)) continue;
    const [op, ...rest] = raw.split(".");
    const val = rest.join(".");
    const cell = row[col] == null ? "" : String(row[col]);
    if (op === "eq" && cell !== val) return false;
    if (op === "ilike") {
      const re = new RegExp("^" + val.replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]])/g, (m, esc, wild, special) =>
        esc ? "\\" + esc : wild === "%" ? ".*" : wild === "_" ? "." : "\\" + special) + "$", "i");
      if (!re.test(cell)) return false;
    }
  }
  return true;
}

let fakeSupabase;
before(async () => {
  fakeSupabase = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };

    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers.authorization || "").replace("Bearer ", "");
      return sessions[token] ? send(200, { id: "u-" + sessions[token], email: sessions[token] }) : send(401, { msg: "bad jwt" });
    }
    if (url.pathname === "/auth/v1/admin/users" && req.method === "POST") {
      if (authUsers.find(u => u.email === json.email)) return send(422, { msg: "A user with this email address has already been registered" });
      const u = { id: "auth" + nextId++, email: json.email, password: json.password };
      authUsers.push(u);
      return send(200, u);
    }
    if (url.pathname === "/auth/v1/admin/users" && req.method === "GET") return send(200, { users: authUsers });
    if (url.pathname.startsWith("/auth/v1/admin/users/") && req.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      const i = authUsers.findIndex(u => u.id === id);
      if (i >= 0) authUsers.splice(i, 1);
      return send(200, {});
    }
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (m) {
      const table = db[m[1]];
      if (!table) return send(404, { message: "no table" });
      const params = [...url.searchParams.entries()];
      if (req.method === "GET") return send(200, table.filter(r => matches(r, params)));
      if (req.method === "POST") {
        const rows = json.map(r => ({ id: "row" + nextId++, created_at: "now", ...r }));
        const key = url.searchParams.get("on_conflict");
        for (const r of rows) {
          const i = key ? table.findIndex(x => x[key] === r[key]) : -1;
          if (i >= 0) table[i] = { ...table[i], ...r }; else table.push(r);
        }
        return send(201, rows);
      }
      if (req.method === "PATCH") { table.filter(r => matches(r, params)).forEach(r => Object.assign(r, json)); return send(204); }
      if (req.method === "DELETE") { for (let i = table.length - 1; i >= 0; i--) if (matches(table[i], params)) table.splice(i, 1); return send(204); }
    }
    send(404, { message: "not faked: " + req.method + " " + url.pathname });
  });
  await new Promise(r => fakeSupabase.listen(0, r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${fakeSupabase.address().port}`;
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  process.env.LEGACY_MODE = "true";
  delete process.env.ANTHROPIC_API_KEY;

  const app = require("../server.js");
  appServer = app.listen(0);
  await new Promise(r => appServer.once("listening", r));
  base = `http://127.0.0.1:${appServer.address().port}`;
});
let appServer, base;
after(() => { appServer.close(); fakeSupabase.close(); Module._load = realLoad; });

function signIn(email) { const t = "tok-" + email; sessions[t] = email; return t; }
async function call(path, body, token, headers = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("legacy: the old app can still text without a session", async () => {
  const r = await call("/send-sms", { to: "+15555550100", message: "hi" });
  assert.equal(r.body.success, true);
});

test("legacy: old employee sign-in still works with the right password only", async () => {
  assert.equal((await call("/employee-login", { email: "emp_a@test.com", password: "oldpass1" })).body.success, true);
  assert.equal((await call("/employee-login", { email: "emp_a@test.com", password: "wrong" })).status, 401);
});

test("legacy: signed-in requests still get the new checks", async () => {
  const r = await call("/send-sms", { to: "+15555550100", message: "spam", business_id: "bizB" }, signIn("a@test.com"));
  assert.equal(r.status, 403);
});

test("legacy: new employee endpoints still require a login", async () => {
  assert.equal((await call("/employees/create", { business_id: "bizA", name: "x", email: "x@test.com", password: "123456" })).status, 401);
});
