import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

// Dynamic, after the hooks: a static import would resolve 'server-only'
// before the hooks run and throw. Same pattern as the data-io
// payroll-opening-entitlements suite.
const { payrollOpeningBalancesResource } = (await import(
  "./payroll-opening-balances-resource.ts"
)) as typeof import("./payroll-opening-balances-resource.ts");
hooks.deregister();

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} = await import("@openbooks/engine/src/testing/fixtures.ts");

/**
 * Opening-balance import guards: the resource used to save each file row
 * through its own per-row `saveOpeningBalances` call, so the engine's
 * whole-load duplicate guard (`appears more than once in this load`) never
 * fired — the second row for an employee silently overwrote the first, in
 * both preview and commit. And a blank row with no stored carry-in reported
 * `updated: 1` in preview while the commit wrote nothing.
 *
 * The resource now preflights resolved employee+taxYear duplicates across the
 * WHOLE input before any save (both modes refuse every row sharing the key),
 * and a blank row with nothing stored reports a truthful nothing-written
 * outcome with an advisory warning.
 *
 * DB partition: scratch org, synthetic data only, no DDL.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedEmployee(
  orgId: string,
  actorId: string,
  name: string,
  code: string,
): Promise<void> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, short_code, is_active, custom)
    values (${id}, ${orgId}, 'person', ${name}, ${code}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, terminated_on, is_active,
                               created_by, updated_by)
    values (${orgId}, ${id}, '2016-01-06', null, true, ${actorId}, ${actorId})`);
}

async function openingCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from payroll_opening_balances where org_id = ${orgId}`));
  return rows.rows[0]!.n;
}

async function auditActions(orgId: string): Promise<string[]> {
  const rows = (await db.execute<{ action: string }>(sql`
    select action from audit_log
     where org_id = ${orgId} and table_name = 'payroll_opening_balances'
     order by id`));
  return rows.rows.map((r) => r.action);
}

async function storedTaxable(orgId: string): Promise<string | null> {
  const rows = (await db.execute<{ taxable_ytd: string }>(sql`
    select taxable_ytd from payroll_opening_balances where org_id = ${orgId}`));
  return rows.rows[0]?.taxable_ytd ?? null;
}

function carryIn(employee: string, taxable: string, tax: string) {
  return { employee, taxYear: 2026, taxableYtd: taxable, taxYtd: tax };
}

test(
  "conflicting duplicate rows refuse in preview AND commit, writing nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedEmployee(org.orgId, actorId, "Aldo Rossi", "ALDO01");
    const resource = payrollOpeningBalancesResource(org.orgId);
    const ctx = {
      orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null,
    };
    // Same employee twice under two spellings (name, then code): keying on
    // the raw cell would miss this, so the guard must use the RESOLVED id.
    const rows = [
      carryIn("Aldo Rossi", "50000", "8000"),
      carryIn("ALDO01", "60000", "9000"),
    ];
    try {
      const preview = await resource.write(rows, "insert", ctx);
      assert.equal(preview.created, 0);
      assert.equal(preview.updated, 0);
      assert.equal(preview.failed, 2);
      for (const error of preview.errors) {
        assert.equal(error.field, "employee");
        assert.match(error.message, /more than once/);
      }
      assert.equal(await openingCount(org.orgId), 0);

      const committed = await resource.write(rows, "insert", { ...ctx, dryRun: false });
      assert.equal(committed.created, 0);
      assert.equal(committed.updated, 0);
      assert.equal(committed.failed, 2);
      for (const error of committed.errors) {
        assert.equal(error.field, "employee");
        assert.match(error.message, /more than once/);
      }
      // Neither conflicting value won: no row, no audit evidence.
      assert.equal(await openingCount(org.orgId), 0);
      assert.deepEqual(await auditActions(org.orgId), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "identical repeat rows still refuse per the engine duplicate contract",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedEmployee(org.orgId, actorId, "Bianca Neri", "BIA01");
    const resource = payrollOpeningBalancesResource(org.orgId);
    const ctx = {
      orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null,
    };
    const rows = [
      carryIn("Bianca Neri", "50000", "8000"),
      carryIn("Bianca Neri", "50000", "8000"),
    ];
    try {
      const preview = await resource.write(rows, "insert", ctx);
      assert.equal(preview.failed, 2);
      assert.equal(preview.created, 0);
      assert.equal(preview.updated, 0);

      const committed = await resource.write(rows, "insert", { ...ctx, dryRun: false });
      assert.equal(committed.failed, 2);
      assert.equal(committed.created, 0);
      assert.equal(committed.updated, 0);
      assert.equal(await openingCount(org.orgId), 0);
      assert.deepEqual(await auditActions(org.orgId), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "restricted caller sees scope errors for alias duplicates, never duplicate evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedEmployee(org.orgId, actorId, "Elsa Gialli", "ELS01");
    const resource = payrollOpeningBalancesResource(org.orgId);
    // Empty allow-list: every employee is outside the caller's scope.
    const ctx = {
      orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: new Set<string>(),
    };
    // Two spellings of one hidden employee: scope runs before duplicate
    // grouping, so both rows fail closed with scope errors rather than
    // disclosing through a duplicate error that the name resolves.
    const rows = [
      carryIn("Elsa Gialli", "50000", "8000"),
      carryIn("ELS01", "60000", "9000"),
    ];
    try {
      const preview = await resource.write(rows, "insert", ctx);
      assert.equal(preview.failed, 2);
      assert.equal(preview.created, 0);
      assert.equal(preview.updated, 0);
      for (const error of preview.errors) {
        assert.equal(error.field, "employee");
        assert.match(error.message, /outside the caller's subsidiary scope/);
        assert.doesNotMatch(error.message, /more than once/);
      }
      assert.equal(await openingCount(org.orgId), 0);

      const committed = await resource.write(rows, "insert", { ...ctx, dryRun: false });
      assert.equal(committed.failed, 2);
      assert.equal(committed.created, 0);
      assert.equal(committed.updated, 0);
      for (const error of committed.errors) {
        assert.equal(error.field, "employee");
        assert.match(error.message, /outside the caller's subsidiary scope/);
        assert.doesNotMatch(error.message, /more than once/);
      }
      assert.equal(await openingCount(org.orgId), 0);
      assert.deepEqual(await auditActions(org.orgId), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "blank row with no stored carry-in claims nothing in preview AND commit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedEmployee(org.orgId, actorId, "Carlo Bianchi", "CAR01");
    const resource = payrollOpeningBalancesResource(org.orgId);
    const ctx = {
      orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null,
    };
    const rows = [{ employee: "Carlo Bianchi", taxYear: 2026 }];
    try {
      const preview = await resource.write(rows, "insert", ctx);
      assert.equal(preview.failed, 0);
      assert.equal(preview.created, 0);
      assert.equal(preview.updated, 0);
      assert.equal(preview.warnings?.length, 1);
      assert.match(preview.warnings![0]!.message, /nothing/i);

      const committed = await resource.write(rows, "insert", { ...ctx, dryRun: false });
      assert.equal(committed.failed, 0);
      assert.equal(committed.created, 0);
      assert.equal(committed.updated, 0);
      assert.equal(committed.warnings?.length, 1);
      assert.equal(await openingCount(org.orgId), 0);
      assert.deepEqual(await auditActions(org.orgId), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "normal load stores with audit, and clearing a stored opening deletes it",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedEmployee(org.orgId, actorId, "Dora Verdi", "DOR01");
    const resource = payrollOpeningBalancesResource(org.orgId);
    const ctx = {
      orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null,
    };
    try {
      const preview = await resource.write(
        [carryIn("Dora Verdi", "50000", "8000")], "insert", ctx,
      );
      assert.deepEqual(preview.errors, []);
      assert.equal(preview.created, 1);
      assert.equal(preview.updated, 0);
      assert.equal(await openingCount(org.orgId), 0);

      const committed = await resource.write(
        [carryIn("Dora Verdi", "50000", "8000")], "insert", { ...ctx, dryRun: false },
      );
      assert.deepEqual(committed.errors, []);
      assert.equal(committed.created, 1);
      assert.equal(await openingCount(org.orgId), 1);
      assert.equal(await storedTaxable(org.orgId), "50000.0000");
      assert.deepEqual(await auditActions(org.orgId), ["insert"]);

      // An all-blank row for an employee WITH a carry-in clears it: preview
      // and commit agree it is an update, storage is gone, and the delete is
      // audited with what it removed.
      const clearPreview = await resource.write(
        [{ employee: "Dora Verdi", taxYear: 2026 }], "insert", ctx,
      );
      assert.deepEqual(clearPreview.errors, []);
      assert.equal(clearPreview.updated, 1);

      const cleared = await resource.write(
        [{ employee: "Dora Verdi", taxYear: 2026 }], "insert", { ...ctx, dryRun: false },
      );
      assert.deepEqual(cleared.errors, []);
      assert.equal(cleared.updated, 1);
      assert.equal(await openingCount(org.orgId), 0);
      assert.deepEqual(await auditActions(org.orgId), ["insert", "delete"]);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
