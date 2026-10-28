// Sales CRM → Account Manager CRM handoff.
//
// The Sales CRM (a separate system with its own database) calls these two
// endpoints with a shared secret in the "x-handoff-key" header:
//
//   GET  /handoff/packages  the packages it can sell (the list lives here, decision #24)
//   POST /handoff/sale      a new client, sent once Stripe confirms the first payment (decision #23)
//
// /handoff/sale creates the client (or finds the existing one with that email),
// assigns the active account manager with the fewest clients (decision #106),
// stores a copy of the package terms, writes the Activity Log and creates an
// onboarding task. It is safe to call again for the same sale: the second call
// changes nothing and returns the same client.

const crypto = require("crypto");
const express = require("express");
const { sbAdmin, lower } = require("./access");

const enc = encodeURIComponent;
const exact = s => s.replace(/[\\%_]/g, m => "\\" + m);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = n => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

function easternDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // YYYY-MM-DD
}

function requireHandoffKey(req, res, next) {
  const secret = process.env.HANDOFF_SECRET || "";
  if (secret.length < 24) return res.status(503).json({ error: "The handoff isn't set up on the server yet (HANDOFF_SECRET)." });
  const given = Buffer.from(String(req.get("x-handoff-key") || ""));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: "Wrong handoff key." });
  }
  next();
}

async function listPackages() {
  return sbAdmin("/rest/v1/packages?select=id,slug,name,monthly_price,description,services,active,version,sort&active=eq.true&order=sort.asc");
}

// The active account manager with the fewest active clients; ties go to whoever joined first.
async function pickAccountManager() {
  const ams = await sbAdmin("/rest/v1/account_managers?select=id,name,email,marketing_company_id,created_at&active=eq.true&order=created_at.asc");
  if (!ams.length) return null;
  const clients = await sbAdmin("/rest/v1/businesses?select=account_manager_id,status");
  const load = {};
  for (const b of clients) {
    if (b.account_manager_id && b.status !== "canceled") load[b.account_manager_id] = (load[b.account_manager_id] || 0) + 1;
  }
  return ams.reduce((best, am) => ((load[am.id] || 0) < (load[best.id] || 0) ? am : best), ams[0]);
}

function readSale(body) {
  const b = body || {};
  const sale = {
    sale_id: String(b.sale_id || "").trim(),
    business_name: String(b.business_name || "").trim(),
    contact_name: String(b.contact_name || "").trim() || null,
    email: lower(b.email),
    phone: String(b.phone || "").trim() || null,
    package_id: String(b.package_id || "").trim(),
    monthly_price: Number(b.monthly_price),
    setup_fee: Number(b.setup_fee || 0),
    sold_by: String(b.sold_by || "").trim() || null,
    notes: String(b.notes || "").trim() || null,
    first_paid_at: b.first_paid_at ? new Date(b.first_paid_at).toISOString() : new Date().toISOString(),
    stripe_customer_id: b.stripe_customer_id || null,
    stripe_subscription_id: b.stripe_subscription_id || null,
  };
  const missing = [];
  if (!sale.sale_id) missing.push("sale_id");
  if (!sale.business_name) missing.push("business_name");
  if (!EMAIL.test(sale.email)) missing.push("email");
  if (!sale.package_id) missing.push("package_id");
  if (!Number.isFinite(sale.monthly_price) || sale.monthly_price < 0) missing.push("monthly_price");
  if (!Number.isFinite(sale.setup_fee) || sale.setup_fee < 0) missing.push("setup_fee");
  return { sale, missing };
}

async function handOff(sale) {
  // Already handed off? Same answer again, nothing changes.
  const done = await sbAdmin(`/rest/v1/client_packages?select=business_id&sales_sale_id=eq.${enc(sale.sale_id)}`);
  if (done.length) return { business_id: done[0].business_id, already: true };

  const [pkg] = await sbAdmin(`/rest/v1/packages?select=*&id=eq.${enc(sale.package_id)}`);
  if (!pkg) { const e = new Error("That package doesn't exist in the Account Manager CRM."); e.status = 400; throw e; }

  // Existing client with this email (buying again)? Otherwise a new client.
  let [biz] = await sbAdmin(`/rest/v1/businesses?select=id,name,account_manager_id,contact_name,phone&email=ilike.${enc(exact(sale.email))}`);
  let am = null;
  const isNew = !biz;
  if (isNew) {
    am = await pickAccountManager();
    [biz] = await sbAdmin("/rest/v1/businesses", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: [{
        name: sale.business_name,
        email: sale.email,
        contact_name: sale.contact_name,
        phone: sale.phone,
        status: "onboarding",
        client_since: easternDate(),
        account_manager_id: am ? am.id : null,
        marketing_company_id: am ? am.marketing_company_id : null,
      }],
    });
  } else {
    const fill = {};
    if (!biz.contact_name && sale.contact_name) fill.contact_name = sale.contact_name;
    if (!biz.phone && sale.phone) fill.phone = sale.phone;
    if (!biz.account_manager_id) {
      am = await pickAccountManager();
      if (am) { fill.account_manager_id = am.id; fill.marketing_company_id = am.marketing_company_id; }
    }
    if (Object.keys(fill).length) await sbAdmin(`/rest/v1/businesses?id=eq.${enc(biz.id)}`, { method: "PATCH", body: fill });
    if (!am && biz.account_manager_id) {
      [am] = await sbAdmin(`/rest/v1/account_managers?select=id,name,email&id=eq.${enc(biz.account_manager_id)}`);
    }
    // A new purchase replaces whatever package they had.
    await sbAdmin(`/rest/v1/client_packages?business_id=eq.${enc(biz.id)}&ended_at=is.null`, {
      method: "PATCH", body: { ended_at: new Date().toISOString() },
    });
  }

  try {
    await sbAdmin("/rest/v1/client_packages", {
      method: "POST",
      body: [{
        business_id: biz.id,
        package_id: pkg.id,
        package_name: pkg.name,
        package_version: pkg.version,
        monthly_price: sale.monthly_price,
        setup_fee: sale.setup_fee,
        services: pkg.services,
        checklist: pkg.checklist,
        started_at: sale.first_paid_at,
        source: "sales_handoff",
        sales_sale_id: sale.sale_id,
        sold_by: sale.sold_by,
        sales_notes: sale.notes,
        first_paid_at: sale.first_paid_at,
        stripe_customer_id: sale.stripe_customer_id,
        stripe_subscription_id: sale.stripe_subscription_id,
        created_by: "Sales CRM",
      }],
    });
  } catch (err) {
    // Two deliveries of the same sale at once: the other one won.
    if (err.status === 409) return { business_id: biz.id, already: true };
    throw err;
  }

  const terms = `${pkg.name} (${money(sale.monthly_price)}/mo${sale.setup_fee ? `, ${money(sale.setup_fee)} setup` : ""})`;
  const who = am ? am.name : "no one yet (no active account managers)";
  await sbAdmin("/rest/v1/activity_log", {
    method: "POST",
    body: [{
      business_id: biz.id,
      actor_name: "Sales CRM",
      action: isNew ? "client.handoff" : "package.handoff",
      summary: isNew
        ? `New client from Sales: ${terms}${sale.sold_by ? `, sold by ${sale.sold_by}` : ""}. Assigned to ${who}.`
        : `New purchase from Sales: ${terms}${sale.sold_by ? `, sold by ${sale.sold_by}` : ""}.`,
      detail: { sale_id: sale.sale_id, package: pkg.name, package_version: pkg.version, monthly_price: sale.monthly_price, setup_fee: sale.setup_fee, account_manager: am ? am.email : null },
    }],
  });

  if (isNew) {
    await sbAdmin("/rest/v1/tasks", {
      method: "POST",
      body: [{
        business_id: biz.id,
        account_manager_id: am ? am.id : null,
        marketing_company_id: am ? am.marketing_company_id : null,
        title: `Onboard ${sale.business_name}`,
        notes: [
          `New ${terms} client${sale.sold_by ? `, sold by ${sale.sold_by}` : ""}.`,
          sale.contact_name || sale.phone ? `Contact: ${[sale.contact_name, sale.phone, sale.email].filter(Boolean).join(" · ")}` : `Email: ${sale.email}`,
          sale.notes ? `Sales notes: ${sale.notes}` : null,
          "Confirm the onboarding call is booked, then run onboarding.",
        ].filter(Boolean).join("\n"),
        due_date: easternDate(2),
      }],
    });
  }

  return { business_id: biz.id, already: false, new_client: isNew, account_manager: am ? { name: am.name, email: am.email } : null };
}

function handoffRouter() {
  const router = express.Router();
  router.use(requireHandoffKey);
  router.get("/packages", async (req, res, next) => {
    try { res.json({ packages: await listPackages() }); } catch (e) { next(e); }
  });
  router.post("/sale", async (req, res, next) => {
    try {
      const { sale, missing } = readSale(req.body);
      if (missing.length) return res.status(400).json({ error: `Missing or invalid: ${missing.join(", ")}` });
      res.json({ ok: true, ...(await handOff(sale)) });
    } catch (e) {
      if (e.status === 400) return res.status(400).json({ error: e.message });
      next(e);
    }
  });
  return router;
}

module.exports = { handoffRouter, pickAccountManager, readSale };
