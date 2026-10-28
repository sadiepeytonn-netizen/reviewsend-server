// One-time move of client employees onto real Supabase logins.
//
// For every employee who still has a password saved in the employees table,
// this creates a Supabase login with that SAME password, so the employee
// notices nothing. It then records the login on the employee row. It does not
// delete the old passwords; the cleanup migration does that afterwards.
//
// Usage (needs SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment):
//   node scripts/migrate-employees.js            # dry run: shows what would happen
//   node scripts/migrate-employees.js --apply    # actually creates the logins

const { sbAdmin, lower } = require("../lib/access");

const APPLY = process.argv.includes("--apply");

async function listAllAuthUsers() {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const data = await sbAdmin(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = data?.users || [];
    all.push(...users);
    if (users.length < 200) break;
  }
  return all;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.");
    process.exit(1);
  }
  console.log(`Supabase project: ${process.env.SUPABASE_URL}`);
  console.log(APPLY ? "MODE: APPLY (logins will be created)\n" : "MODE: DRY RUN (nothing will change)\n");

  const employees = await sbAdmin(`/rest/v1/employees?select=id,email,name,business_id,password,auth_user_id`);
  const users = await listAllAuthUsers();
  const byEmail = new Map(users.map(u => [lower(u.email), u]));

  const report = { created: [], linkedExisting: [], alreadyDone: [], needsReset: [], failed: [] };

  for (const emp of employees) {
    const email = lower(emp.email);
    if (emp.auth_user_id) { report.alreadyDone.push(email); continue; }
    const existing = byEmail.get(email);

    if (existing) {
      // A login already exists for this email (for example the same person is
      // also a business owner). Link it, but we can't set its password.
      report.linkedExisting.push(email);
      if (APPLY) {
        await sbAdmin(`/rest/v1/employees?id=eq.${emp.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { auth_user_id: existing.id } });
      }
      continue;
    }
    if (!emp.password || String(emp.password).length < 6) {
      report.needsReset.push(`${email} (no password or shorter than 6 characters)`);
      continue;
    }
    if (!APPLY) { report.created.push(email); continue; }
    try {
      const user = await sbAdmin(`/auth/v1/admin/users`, {
        method: "POST",
        body: { email, password: emp.password, email_confirm: true, user_metadata: { role: "employee", business_id: emp.business_id } },
      });
      await sbAdmin(`/rest/v1/employees?id=eq.${emp.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { auth_user_id: user.id } });
      report.created.push(email);
    } catch (err) {
      report.failed.push(`${email}: ${err.message}`);
    }
  }

  const show = (label, list) => { console.log(`${label}: ${list.length}`); list.forEach(x => console.log(`   - ${x}`)); };
  show(APPLY ? "Logins created (same password)" : "Would create logins (same password)", report.created);
  show("Linked to a login that already existed (password unchanged)", report.linkedExisting);
  show("Already moved earlier", report.alreadyDone);
  show("Need a password reset (couldn't keep their password)", report.needsReset);
  show("Failed", report.failed);
  if (report.failed.length) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
