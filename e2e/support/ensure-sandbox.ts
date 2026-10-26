/**
 * Ensure the E2E admin's production organization has a ready sandbox for the
 * workspace-switching suite, creating one through the native sandbox lifecycle
 * when absent. Prints `{ productionOrgId, productionName, sandboxOrgId,
 * sandboxName }` as JSON on the last line.
 *
 * Safety: refuses anything that looks like production (the 10.0.0.85 estate)
 * and only targets a local or `openbooks_e2e` database. Run with
 * `node --import tsx` (NOT `npx tsx`).
 */
import { sql } from "drizzle-orm";
import { db, env, pool, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { installEngineSeams } from "@openbooks/engine/composition/install";
import { createSandbox } from "@openbooks/engine/sandbox/lifecycle";
import { listSandboxes } from "@openbooks/engine/sandbox/runtime";

const SANDBOX_NAME = "E2E switching sandbox";

async function main(): Promise<void> {
  // The connection the engine will actually use, after its own .env loading.
  const dbUrl = env.OPENBOOKS_DB_URL ?? "";
  const email = (process.env.E2E_EMAIL ?? "e2e@openbooks.test").toLowerCase();
  if (!dbUrl) throw new Error("OPENBOOKS_DB_URL is required");
  if (/10\.0\.0\.85/.test(dbUrl)) throw new Error("refusing to seed: production database");
  if (!/localhost|127\.0\.0\.1|openbooks_e2e/.test(dbUrl))
    throw new Error("refusing to seed: unexpected database");
  installEngineSeams();

  // bypass: cross-org-by-design — the test login is resolved before any organization scope exists.
  const admin = await withBypassContext(
    async () =>
      (
        await db.execute<{ id: string; orgId: string; orgName: string }>(
          sql`
    select u.id, u.org_id as "orgId", o.name as "orgName"
      from users u join orgs o on o.id = u.org_id
     where lower(u.email) = ${email} and u.is_active and o.env_kind = 'production'
     order by u.created_at limit 1`,
          "objects",
        )
      )[0],
  );
  if (!admin) throw new Error(`no active production user ${email}`);

  const sandbox = await withOrgContext(admin.orgId, async () => {
    const existing = (await listSandboxes(admin.orgId)).find(
      (row) => row.name === SANDBOX_NAME && row.status === "ready",
    );
    if (existing) return { orgId: existing.orgId };
    const created = await createSandbox({
      productionOrgId: admin.orgId,
      name: SANDBOX_NAME,
      tier: "full",
      masked: false,
      createdBy: admin.id,
      lifecycleAuthority: { actorId: admin.id },
    });
    return { orgId: created.sandboxOrgId };
  });

  console.log(
    JSON.stringify({
      productionOrgId: admin.orgId,
      productionName: admin.orgName,
      sandboxOrgId: sandbox.orgId,
      sandboxName: SANDBOX_NAME,
    }),
  );
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end().catch(() => {});
    process.exit(1);
  });
