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
  employees: [{ id: "e1", business_id: "bizA", email: "emp_a@test.com", name: "Emp A" }],
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
  process.env.LEGACY_MODE = "false";
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

test("texting without signing in is refused", async () => {
  const r = await call("/send-sms", { to: "+15555550100", message: "hi", business_id: "bizA" });
  assert.equal(r.status, 401);
  assert.equal(sentTexts.length, 0);
});

test("a fake or expired session is refused", async () => {
  const r = await call("/send-sms", { to: "+15555550100", message: "hi", business_id: "bizA" }, "made-up-token");
  assert.equal(r.status, 401);
});

test("a client can text for their own business", async () => {
  const r = await call("/send-sms", { to: "+15555550100", message: "Hi! Review us", business_id: "bizA" }, signIn("a@test.com"));
  assert.equal(r.body.success, true);
  assert.equal(sentTexts.at(-1).to, "+15555550100");
});

test("a client cannot text on behalf of another business", async () => {
  const before = sentTexts.length;
  const r = await call("/send-sms", { to: "+15555550100", message: "spam", business_id: "bizB" }, signIn("a@test.com"));
  assert.equal(r.status, 403);
  assert.equal(sentTexts.length, before);
});

test("someone with a login but no business cannot text", async () => {
  const r = await call("/send-sms", { to: "+15555550100", message: "spam", business_id: "bizA" }, signIn("stranger@test.com"));
  assert.equal(r.status, 403);
});

test("an employee can text for their business", async () => {
  const r = await call("/send-sms", { to: "+15555550101", message: "Thanks!", business_id: "bizA" }, signIn("emp_a@test.com"));
  assert.equal(r.body.success, true);
});

test("a look-alike email (underscore wildcard) gets no employee access", async () => {
  const r = await call("/send-sms", { to: "+15555550101", message: "x", business_id: "bizA" }, signIn("empXa@test.com"));
  assert.equal(r.status, 403);
});

test("picture texts always use the business's own logo, never a link from the browser", async () => {
  const r = await call("/send-mms", { to: "+15555550102", message: "Hi", business_id: "bizA", mediaUrl: "https://evil.example/x.png" }, signIn("a@test.com"));
  assert.equal(r.body.success, true);
  assert.deepEqual(sentTexts.at(-1).mediaUrl, ["https://cdn/logoA.png"]);
});

test("bad phone numbers are rejected before Twilio", async () => {
  const before = sentTexts.length;
  const r = await call("/send-sms", { to: "12345", message: "Hi", business_id: "bizA" }, signIn("a@test.com"));
  assert.equal(r.body.success, false);
  assert.equal(sentTexts.length, before);
});

test("staff see their clients: marketing company (case-insensitive email) and account manager", async () => {
  assert.equal((await call("/send-sms", { to: "+15555550103", message: "x", business_id: "bizB" }, signIn("mc1@test.com"))).body.success, true);
  assert.equal((await call("/send-sms", { to: "+15555550103", message: "x", business_id: "bizC" }, signIn("mc1@test.com"))).status, 403);
  assert.equal((await call("/send-sms", { to: "+15555550103", message: "x", business_id: "bizA" }, signIn("am1@test.com"))).body.success, true);
  assert.equal((await call("/send-sms", { to: "+15555550103", message: "x", business_id: "bizB" }, signIn("am1@test.com"))).status, 403);
});

test("only staff can create or delete logins", async () => {
  assert.equal((await call("/create-user", { email: "new@test.com" })).status, 401);
  assert.equal((await call("/create-user", { email: "new@test.com" }, signIn("a@test.com"))).status, 403);
  const ok = await call("/create-user", { email: "New@Test.com" }, signIn("bentonisaiah03@gmail.com"));
  assert.equal(ok.body.success, true);
  assert.ok(authUsers.find(u => u.email === "new@test.com"));
  assert.equal((await call("/delete-user", { email: "new@test.com" }, signIn("b@test.com"))).status, 403);
});

test("staff logins cannot be deleted through the app", async () => {
  authUsers.push({ id: "authAM1", email: "am1@test.com" });
  const r = await call("/delete-user", { email: "am1@test.com" }, signIn("mc1@test.com"));
  assert.equal(r.body.success, false);
  assert.ok(authUsers.find(u => u.email === "am1@test.com"));
});

test("invite emails can only be sent by staff", async () => {
  assert.equal((await call("/send-invite", { email: "x@test.com", businessName: "<b>Hi</b>" })).status, 401);
  assert.equal((await call("/send-invite", { email: "x@test.com", businessName: "x" }, signIn("a@test.com"))).status, 403);
});

test("a client owner can add an employee; the password goes to Supabase, not our table", async () => {
  const r = await call("/employees/create", { business_id: "bizA", name: "New Hire", email: "hire@test.com", password: "hunter22" }, signIn("a@test.com"));
  assert.equal(r.body.success, true);
  const row = db.employees.find(e => e.email === "hire@test.com");
  assert.ok(row.auth_user_id);
  assert.equal(row.password, undefined);
  assert.equal(authUsers.find(u => u.email === "hire@test.com").password, "hunter22");
});

test("an employee cannot add other employees", async () => {
  const r = await call("/employees/create", { business_id: "bizA", name: "X", email: "x2@test.com", password: "hunter22" }, signIn("emp_a@test.com"));
  assert.equal(r.status, 403);
});

test("a client cannot add an employee to another business", async () => {
  const r = await call("/employees/create", { business_id: "bizB", name: "X", email: "x3@test.com", password: "hunter22" }, signIn("a@test.com"));
  assert.equal(r.status, 403);
});

test("an employee can't be created with an email that already has a login", async () => {
  const r = await call("/employees/create", { business_id: "bizA", name: "X", email: "b@test.com", password: "hunter22" }, signIn("a@test.com"));
  assert.equal(r.body.success, false);
});

test("removing an employee removes their login too", async () => {
  const emp = db.employees.find(e => e.email === "hire@test.com");
  const r = await call("/employees/delete", { business_id: "bizA", employee_id: emp.id }, signIn("a@test.com"));
  assert.equal(r.body.success, true);
  assert.equal(db.employees.find(e => e.email === "hire@test.com"), undefined);
  assert.equal(authUsers.find(u => u.email === "hire@test.com"), undefined);
});

test("Google data needs a login and access to that business", async () => {
  assert.equal((await call("/google/data", { business_id: "bizA", access_token: "stolen" })).status, 401);
  assert.equal((await call("/google/data", { business_id: "bizA" }, signIn("b@test.com"))).status, 403);
  const r = await call("/google/data", { business_id: "bizA" }, signIn("a@test.com"));
  assert.equal(r.body.success, false);
  assert.equal(r.body.needs_reconnect, true); // no keys stored yet in the fake
});

test("old endpoints that handed Google keys to the browser are switched off", async () => {
  assert.equal((await call("/google/token", { code: "x" })).status, 410);
  assert.equal((await call("/google/refresh-token", { refresh_token: "x" })).status, 410);
  assert.equal((await call("/employee-login", { email: "emp_a@test.com", password: "x" })).status, 410);
});

test("connecting Google only accepts our own return address", async () => {
  const r = await call("/google/connect", { business_id: "bizA", code: "abc", redirect_uri: "https://evil.example" }, signIn("a@test.com"));
  assert.equal(r.body.success, false);
});

test("AI captions need a login", async () => {
  assert.equal((await call("/ai/caption", { business_id: "bizA", prompt: "x" })).status, 401);
  const r = await call("/ai/caption", { business_id: "bizA", prompt: "x" }, signIn("a@test.com"));
  assert.equal(r.body.success, false); // no AI key configured in the test
});

test("other websites can't call the server from a browser", async () => {
  const r = await fetch(base + "/send-sms", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const ok = await fetch(base + "/send-sms", { method: "OPTIONS", headers: { Origin: "https://app.reviewsend.io", "Access-Control-Request-Method": "POST" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.reviewsend.io");
});
