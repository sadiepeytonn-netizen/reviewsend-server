// Tests for the Sales CRM → Account Manager CRM handoff, against a small fake Supabase.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "twilio") return () => ({ messages: { create: async () => ({ sid: "SM1" }) } });
  return realLoad.call(this, request, ...rest);
};

const KEY = "test-handoff-secret-0123456789abcdef";
const db = {
  packages: [
    { id: "pkg-starter", slug: "starter", name: "Starter", monthly_price: 399, version: 1, sort: 1, active: true, services: [{ label: "Posts", minutes: "35 min" }], checklist: ["a", "b"] },
    { id: "pkg-pro", slug: "pro", name: "Pro", monthly_price: 549, version: 3, sort: 2, active: true, services: [], checklist: ["a", "b", "c"] },
    { id: "pkg-old", slug: "old", name: "Old", monthly_price: 199, version: 1, sort: 3, active: false, services: [], checklist: [] },
  ],
  account_managers: [
    { id: "am-busy", name: "Busy AM", email: "busy@test.com", marketing_company_id: "mc1", active: true, created_at: "2026-01-01" },
    { id: "am-free", name: "Free AM", email: "free@test.com", marketing_company_id: "mc1", active: true, created_at: "2026-02-01" },
    { id: "am-off", name: "Inactive AM", email: "off@test.com", marketing_company_id: "mc1", active: false, created_at: "2025-01-01" },
  ],
  businesses: [
    { id: "b1", name: "One", email: "one@test.com", account_manager_id: "am-busy", status: "active" },
    { id: "b2", name: "Two", email: "two@test.com", account_manager_id: "am-busy", status: "active" },
    { id: "b3", name: "Gone", email: "gone@test.com", account_manager_id: "am-free", status: "canceled" },
    { id: "b4", name: "Existing Co", email: "Existing@Test.com", account_manager_id: "am-free", status: "active", contact_name: null, phone: "+15550001111" },
  ],
  client_packages: [{ id: "cp-old", business_id: "b4", package_name: "Starter", ended_at: null, sales_sale_id: null }],
  activity_log: [],
  tasks: [],
};
let nextId = 1;

function matches(row, params) {
  for (const [col, raw] of params) {
    if (["select", "order", "on_conflict"].includes(col)) continue;
    const [op, ...rest] = raw.split(".");
    const val = rest.join(".");
    const cell = row[col] == null ? null : String(row[col]);
    if (op === "eq" && cell !== val) return false;
    if (op === "is" && val === "null" && cell !== null) return false;
    if (op === "ilike" && (cell || "").toLowerCase() !== val.replace(/\\(.)/g, "$1").toLowerCase()) return false;
  }
  return true;
}

let fake, appServer, base;
before(async () => {
  fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)); };
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
    const table = m && db[m[1]];
    if (!table) return send(404, { message: "not faked" });
    const params = [...url.searchParams.entries()];
    if (req.method === "GET") return send(200, table.filter(r => matches(r, params)));
    if (req.method === "POST") {
      const rows = json.map(r => ({ id: "row" + nextId++, ...r }));
      if (m[1] === "client_packages" && rows.some(r => r.sales_sale_id && table.some(x => x.sales_sale_id === r.sales_sale_id))) {
        return send(409, { message: "duplicate key value violates unique constraint" });
      }
      table.push(...rows);
      return send(201, rows);
    }
    if (req.method === "PATCH") { table.filter(r => matches(r, params)).forEach(r => Object.assign(r, json)); return send(204); }
    send(404, { message: "not faked" });
  });
  await new Promise(r => fake.listen(0, r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.SUPABASE_SERVICE_KEY = "service-key";
  process.env.HANDOFF_SECRET = KEY;
  process.env.LEGACY_MODE = "false";
  const app = require("../server.js");
  appServer = app.listen(0);
  await new Promise(r => appServer.once("listening", r));
  base = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => { appServer.close(); fake.close(); Module._load = realLoad; });

const sale = (over = {}) => ({
  sale_id: "sale-1", business_name: "Tahoe Plumbing", contact_name: "Josh", email: "Josh@TahoePlumbing.com",
  phone: "+15551234567", package_id: "pkg-pro", monthly_price: 549, setup_fee: 250, sold_by: "Ryan",
  notes: "Wants more calls", first_paid_at: "2026-10-28T20:00:00Z", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", ...over,
});
async function post(path, body, key = KEY) {
  const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "x-handoff-key": key } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test("no key or wrong key is refused", async () => {
  assert.equal((await post("/handoff/sale", sale(), null)).status, 401);
  assert.equal((await post("/handoff/sale", sale(), KEY.slice(0, -1) + "x")).status, 401);
  const res = await fetch(base + "/handoff/packages");
  assert.equal(res.status, 401);
  assert.equal(db.businesses.length, 4);
});

test("lists only packages on offer", async () => {
  const res = await fetch(base + "/handoff/packages", { headers: { "x-handoff-key": KEY } });
  const { packages } = await res.json();
  assert.deepEqual(packages.map(p => p.name), ["Starter", "Pro"]);
});

test("bad sale details are refused", async () => {
  const r = await post("/handoff/sale", sale({ email: "nope", package_id: "" }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /email/);
  assert.equal((await post("/handoff/sale", sale({ package_id: "pkg-missing" }))).status, 400);
});

test("a new client is created, assigned to the least-busy active AM, with package, log and task", async () => {
  const r = await post("/handoff/sale", sale());
  assert.equal(r.status, 200);
  assert.equal(r.body.new_client, true);
  assert.equal(r.body.account_manager.email, "free@test.com"); // busy has 2; free has 0 active (one canceled); inactive skipped
  const biz = db.businesses.find(b => b.id === r.body.business_id);
  assert.equal(biz.email, "josh@tahoeplumbing.com");
  assert.equal(biz.status, "onboarding");
  assert.equal(biz.account_manager_id, "am-free");
  const cp = db.client_packages.find(c => c.sales_sale_id === "sale-1");
  assert.equal(cp.package_name, "Pro");
  assert.equal(cp.package_version, 3);
  assert.equal(cp.setup_fee, 250);
  assert.equal(cp.source, "sales_handoff");
  assert.deepEqual(cp.checklist, ["a", "b", "c"]);
  assert.match(db.activity_log.at(-1).summary, /New client from Sales: Pro \(\$549\/mo, \$250 setup\), sold by Ryan\. Assigned to Free AM\./);
  const task = db.tasks.at(-1);
  assert.equal(task.title, "Onboard Tahoe Plumbing");
  assert.equal(task.account_manager_id, "am-free");
});

test("the same sale sent twice changes nothing", async () => {
  const counts = [db.businesses.length, db.client_packages.length, db.activity_log.length, db.tasks.length];
  const r = await post("/handoff/sale", sale());
  assert.equal(r.status, 200);
  assert.equal(r.body.already, true);
  assert.deepEqual([db.businesses.length, db.client_packages.length, db.activity_log.length, db.tasks.length], counts);
});

test("an existing client buying again keeps their AM; old package ends", async () => {
  const r = await post("/handoff/sale", sale({ sale_id: "sale-2", email: "existing@test.com", business_name: "Existing Co", package_id: "pkg-starter", monthly_price: 399, setup_fee: 0 }));
  assert.equal(r.status, 200);
  assert.equal(r.body.business_id, "b4");
  assert.equal(r.body.new_client, false);
  assert.ok(db.client_packages.find(c => c.id === "cp-old").ended_at);
  assert.equal(db.client_packages.filter(c => c.business_id === "b4" && !c.ended_at).length, 1);
  const b4 = db.businesses.find(b => b.id === "b4");
  assert.equal(b4.account_manager_id, "am-free");
  assert.equal(b4.contact_name, "Josh"); // blank filled in
  assert.equal(b4.phone, "+15550001111"); // existing kept
  assert.equal(db.tasks.filter(t => t.business_id === "b4").length, 0);
});

test("handoff is off until the secret is set", async () => {
  const saved = process.env.HANDOFF_SECRET;
  process.env.HANDOFF_SECRET = "";
  assert.equal((await post("/handoff/sale", sale({ sale_id: "sale-3" }))).status, 503);
  process.env.HANDOFF_SECRET = saved;
});
