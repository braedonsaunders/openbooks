/**
 * 0747 grants the built-in Approver role expenses.read and refreshes the
 * built-in role descriptions. The test runs the real migration bytes inside
 * one transaction over a scratch organization's built-in roles, checks the
 * grant, its idempotence and that custom roles are untouched, and rolls the
 * transaction back so the database is unchanged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { withBypassContext } from "@openbooks/engine/platform/db";
import { BUILT_IN_ROLES } from "@openbooks/engine/organization/permissions";
import { createScratchOrg, dropScratchOrgReporting } from "@openbooks/engine/testing/fixtures";

const migration = readFileSync(new URL("./0747_approver_expense_read.sql", import.meta.url), "utf8");

test("the built-in Approver gains expense read and built-in descriptions match the catalogue", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    // An existing organization's roles as an earlier catalogue seeded them.
    await client.query(
      `insert into app_roles (org_id, key, name, description, is_built_in, permissions)
       values ($1, 'approver', 'Approver', 'Reviews and decides approval requests.', true, '["ap.read", "flows.approve"]'::jsonb),
              ($1, 'cashier', 'Cashier', 'Rings up cash sales.', true, '["cash_sales.read"]'::jsonb),
              ($1, 'expense_auditor', 'Expense auditor', 'Custom.', false, '["reports.read"]'::jsonb)
       on conflict (org_id, key) do update set description = excluded.description, permissions = excluded.permissions, is_built_in = excluded.is_built_in`,
      [org.orgId],
    );
    await client.query(migration);
    await client.query(migration);
    const roles = new Map((await client.query<{ key: string; description: string; permissions: string[] }>(
      `select key, description, permissions from app_roles where org_id = $1 and key in ('approver', 'cashier', 'expense_auditor')`,
      [org.orgId],
    )).rows.map((row) => [row.key, row]));
    assert.deepEqual(roles.get("approver")!.permissions, ["ap.read", "flows.approve", "expenses.read"], "granted once, earlier grants kept");
    assert.equal(roles.get("approver")!.description, BUILT_IN_ROLES.approver!.description);
    assert.equal(roles.get("cashier")!.description, BUILT_IN_ROLES.cashier!.description);
    assert.deepEqual(roles.get("cashier")!.permissions, ["cash_sales.read"], "only the Approver's grants change");
    assert.deepEqual(roles.get("expense_auditor"), { key: "expense_auditor", description: "Custom.", permissions: ["reports.read"] }, "custom roles are untouched");
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
    await withBypassContext(() => dropScratchOrgReporting(org.orgId));
  }
});
