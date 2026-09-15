/**
 * Seed the second (approver) user for the close-to-reporting E2E workflow.
 *
 * Both the close-approval gate (`preventSelfApproval`) and the controlled
 * reopen decision (`requested_by === actorId` is refused) REQUIRE two distinct
 * actors, and no HTTP endpoint creates users — so the browser job provisions
 * the approver before the specs run. This mirrors `seedAdmin` in
 * `scripts/bootstrap.ts` exactly (scrypt password hash, explicit `admin` role
 * grant) plus the `approver` role the seeded Close approval flow addresses.
 * The suite itself assigns nothing: both logins go through the real
 * `/api/login`, with no test bypass.
 *
 * Safety: refuses to run without `E2E_SEED_APPROVER=1`, refuses anything that
 * looks like production (the 10.0.0.85 estate), and only targets a local or
 * `openbooks_e2e` database. Run with `node --import tsx` (NOT `npx tsx`).
 *
 *   OPENBOOKS_DB_URL=postgres://openbooks:openbooks@localhost:5433/openbooks_e2e \
 *   E2E_SEED_APPROVER=1 \
 *   E2E_APPROVER_EMAIL=approver@openbooks.test \
 *   E2E_APPROVER_PASSWORD=approver-test-password-123 \
 *   node --import tsx e2e/workflows/support/seed-e2e-approver.ts
 */
import { randomBytes, scryptSync } from "node:crypto";
import { Client } from "pg";

const email = (process.env.E2E_APPROVER_EMAIL ?? "approver@openbooks.test").toLowerCase();
const password = process.env.E2E_APPROVER_PASSWORD ?? "approver-test-password-123";
const dbUrl = process.env.OPENBOOKS_DB_URL ?? "";

if (process.env.E2E_SEED_APPROVER !== "1") {
  throw new Error("refusing to seed: set E2E_SEED_APPROVER=1 explicitly");
}
if (!dbUrl) throw new Error("OPENBOOKS_DB_URL is required");
if (/10\.0\.0\.85/.test(dbUrl)) throw new Error("refusing to seed: production database");
if (!/localhost|127\.0\.0\.1|openbooks_e2e/.test(dbUrl)) {
  throw new Error(`refusing to seed: unexpected database (${redact(dbUrl)})`);
}

function redact(url: string): string {
  return url.replace(/:\/\/[^@]+@/, "://***@");
}

const client = new Client({ connectionString: dbUrl });
await client.query("select 1");
const orgs = await client.query<{ id: string }>("select id from orgs order by created_at limit 1");
if (orgs.rows.length !== 1) throw new Error(`expected exactly one org, found ${orgs.rows.length}`);
const orgId = orgs.rows[0]!.id;

const salt = randomBytes(16);
const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
const created = await client.query<{ id: string }>(
  `insert into users (org_id, email, name, password_hash)
   values ($1, $2, 'E2E Approver', $3)
   on conflict (org_id, email) do nothing
   returning id`,
  [orgId, email, hash],
);
const userId =
  created.rows[0]?.id ??
  (await client.query<{ id: string }>("select id from users where org_id = $1 and email = $2", [orgId, email])).rows[0]!.id;

for (const key of ["admin", "approver"]) {
  await client.query(
    `insert into role_assignments (org_id, user_id, role_id)
     select $1, $2, id from app_roles where org_id = $1 and key = $3
     on conflict (org_id, user_id, role_id) do nothing`,
    [orgId, userId, key],
  );
}
await client.end();
console.log(`[e2e-seed] approver ${email} ready (admin + approver roles)`);
