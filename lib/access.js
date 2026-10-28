// Who is calling, and what are they allowed to touch?
//
// Every protected endpoint needs a signed-in ReviewSend user. The browser sends
// that user's Supabase session token in the Authorization header; we ask
// Supabase who it belongs to, then work out their role from the database using
// the server's own (service) key. These rules mirror the database security
// rules in reviewsend-app/supabase/migrations so the server and the database
// always agree on who can see which business.

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_KEY;

// Owners. The app_admins table is the source of truth once the first database
// migration has run; this list is the fallback before then.
const DEFAULT_ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "bentonisaiah03@gmail.com,sadiepeytonn@gmail.com")
  .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

function adminHeaders(extra = {}) {
  return { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, "Content-Type": "application/json", ...extra };
}

// Small helper for the Supabase REST API with the service key. Throws on
// anything other than a 2xx so callers never mistake an error for "no rows".
async function sbAdmin(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL()}${path}`, {
    method,
    headers: adminHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.msg || data.error_description || data.error)) || `Supabase ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;
const lower = s => String(s || "").trim().toLowerCase();

// Look up the signed-in user from their session token.
async function getUserFromToken(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.email) return null;
  return { id: user.id, email: lower(user.email) };
}

// Everything this email is connected to.
async function getAccess(email) {
  email = lower(email);
  // Case-insensitive exact match. "_" and "%" are wildcards in ilike, so they are
  // escaped: otherwise "a_b@x.com" would also match "axb@x.com".
  const eq = enc(email.replace(/[\\%_]/g, m => "\\" + m));
  let isAdmin = DEFAULT_ADMIN_EMAILS.includes(email);
  try {
    const admins = await sbAdmin(`/rest/v1/app_admins?email=ilike.${eq}&select=email`);
    if (admins && admins.length) isAdmin = true;
  } catch { /* table not created yet: fall back to DEFAULT_ADMIN_EMAILS */ }

  const [mcs, ams, owned, emps] = await Promise.all([
    sbAdmin(`/rest/v1/marketing_companies?email=ilike.${eq}&select=id`),
    sbAdmin(`/rest/v1/account_managers?email=ilike.${eq}&select=id`),
    sbAdmin(`/rest/v1/businesses?email=ilike.${eq}&select=id`),
    sbAdmin(`/rest/v1/employees?email=ilike.${eq}&select=business_id`),
  ]);
  return {
    email,
    isAdmin,
    marketingCompanyIds: (mcs || []).map(r => r.id),
    accountManagerIds: (ams || []).map(r => r.id),
    ownedBusinessIds: (owned || []).map(r => r.id),
    employeeBusinessIds: (emps || []).map(r => r.business_id),
  };
}

function isStaff(access) {
  return access.isAdmin || access.marketingCompanyIds.length > 0 || access.accountManagerIds.length > 0;
}

// level: "member" = anyone tied to the business, including its employees
//        "manage" = the business owner or ReviewSend staff
//        "staff"  = ReviewSend staff only (owners, marketing company, assigned account manager)
async function canAccessBusiness(access, businessId, level = "member") {
  if (!businessId) return false;
  const rows = await sbAdmin(`/rest/v1/businesses?id=eq.${enc(businessId)}&select=id,email,name,logo_url,marketing_company_id,account_manager_id,google_account_id,google_location_id`);
  const biz = rows && rows[0];
  if (!biz) return false;
  const staffOk = access.isAdmin
    || (biz.marketing_company_id && access.marketingCompanyIds.includes(biz.marketing_company_id))
    || (biz.account_manager_id && access.accountManagerIds.includes(biz.account_manager_id));
  if (staffOk) return biz;
  if (level === "staff") return false;
  if (lower(biz.email) === access.email) return biz;
  if (level === "manage") return false;
  if (access.employeeBusinessIds.includes(biz.id)) return biz;
  return false;
}

// Express middleware: rejects the request unless a valid ReviewSend session is attached.
function requireUser(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "Please sign in again." });
  getUserFromToken(token)
    .then(async user => {
      if (!user) return res.status(401).json({ success: false, error: "Your session expired. Please sign in again." });
      req.user = user;
      req.access = await getAccess(user.email);
      next();
    })
    .catch(next);
}

// Express middleware factory: requires access to req.body.business_id at the given level.
function requireBusiness(level = "member") {
  return (req, res, next) => {
    const businessId = req.body && req.body.business_id;
    canAccessBusiness(req.access, businessId, level)
      .then(biz => {
        if (!biz) return res.status(403).json({ success: false, error: "You don't have access to this business." });
        req.business = biz;
        next();
      })
      .catch(next);
  };
}

function requireStaff(req, res, next) {
  if (!isStaff(req.access)) return res.status(403).json({ success: false, error: "Only ReviewSend staff can do this." });
  next();
}

module.exports = { sbAdmin, getUserFromToken, getAccess, isStaff, canAccessBusiness, requireUser, requireBusiness, requireStaff, lower };
