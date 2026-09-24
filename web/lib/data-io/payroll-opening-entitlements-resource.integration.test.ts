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
// fixed-asset-resources suite.
const { payrollOpeningEntitlementsResource } = (await import(
  "./payroll-opening-balances-resource.ts"
)) as typeof import("./payroll-opening-balances-resource.ts");
hooks.deregister();

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} = await import("@openbooks/engine/src/testing/fixtures.ts");

/**
 * PAYROLL-1, import-resource half: the bank carry-in resource parsed the
 * amount cell itself — stripping comma/dollar BEFORE exact-decimal
 * validation — and handed the engine save path a pre-normalized figure.
 * A decimal-comma "12,34" was therefore banked as 1234.0000 (100x) on the
 * REAL import path, and the dry run reported success for it. The resource
 * now parses the raw cell through the engine save path's own canonical
 * parser, so preview and commit refuse exactly what the engine refuses.
 *
 * DB partition: scratch org, synthetic data only, no DDL.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

// Seed writes run inside an explicit bypass scope: this file eagerly imports
// a web reader, which replaces the test bypass resolver, so a bare insert
// would reach RLS-governed tables unscoped.
async function seedPlan(orgId: string, actorId: string): Promise<void> {
  return withBypassContext(async () => {
    await db.execute(sql`
      insert into entitlement_plans (id, org_id, code, name, unit, direction, accrual_method,
                                     accrual_value, cap_behavior, is_active, created_by, updated_by)
      values (${randomUUID()}, ${orgId}, 'VAC', 'Vacation', 'money', 'accrue', 'manual',
              null, 'warn', true, ${actorId}, ${actorId})`);
  });
}

async function seedEmployee(orgId: string, actorId: string, name: string, subsidiaryId?: string): Promise<string> {
  return withBypassContext(async () => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
      values (${id}, ${orgId}, 'person', ${name}, true, ${subsidiaryId ?? null}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (org_id, party_id, hired_on, terminated_on, is_active,
                                 created_by, updated_by)
      values (${orgId}, ${id}, '2016-01-06', null, true, ${actorId}, ${actorId})`);
    return id;
  });
}

async function ledgerCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from entitlement_ledger where org_id = ${orgId}`));
  return rows.rows[0]!.n;
}

function row(employee: string, amount: unknown) {
  return { employee, plan: "VAC", asOf: "2026-07-01", amount };
}

test(
  "payroll-1: bank carry-in import refuses locale money in dry-run AND commit, writing nothing",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    await seedPlan(org.orgId, actorId);
    await seedEmployee(org.orgId, actorId, "Aldo Rossi");
    const resource = payrollOpeningEntitlementsResource(org.orgId);
    const ctx = {
      orgId: org.orgId, actorId, dryRun: true, allowedSubsidiaryIds: null,
    };
    try {
      // Dry run: decimal-comma, ambiguous, and grouped amounts all refuse
      // with the precise remedy — the preview must never report success.
      for (const amount of ["12,34", "1,234", "1,234.56"]) {
        const preview = await resource.write([row("Aldo Rossi", amount)], "insert", ctx);
        assert.equal(preview.failed, 1, `dry run accepted ${amount}`);
        assert.equal(preview.created, 0);
        assert.match(
          preview.errors[0]!.message,
          amount === "12,34"
            ? /VAC carry-in must use "\." as the decimal point — write "12,34" as "12\.34"/
            : amount === "1,234"
              ? /is ambiguous — "1,234" could mean 1234 \(thousands separator\) or 1\.234 \(decimal comma\)/
              : /must not contain a thousands separator/,
        );
      }

      // Commit: the same refusal, and nothing lands in the ledger.
      const refused = await resource.write(
        [row("Aldo Rossi", "12,34")],
        "insert",
        { ...ctx, dryRun: false },
      );
      assert.equal(refused.failed, 1);
      assert.equal(refused.created, 0);
      assert.match(refused.errors[0]!.message, /must use "\." as the decimal point/);
      assert.equal(await ledgerCount(org.orgId), 0);

      // Plain decimals still succeed through the same path.
      const ok = await resource.write(
        [row("Aldo Rossi", "1234.56")],
        "insert",
        { ...ctx, dryRun: false },
      );
      assert.deepEqual(ok.errors, []);
      assert.equal(ok.created, 1);
      assert.equal(await ledgerCount(org.orgId), 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the entitlement import rechecks employee scope under the save lock after a concurrent rehome",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
    await seedPlan(org.orgId, actorId);
    const employeeId = await seedEmployee(org.orgId, actorId, "Rehomed Carry In", org.subsidiaryId);
    const resource = payrollOpeningEntitlementsResource(org.orgId);
    const ctx = {
      orgId: org.orgId,
      actorId,
      dryRun: false,
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    };
    let releaseRehome!: () => void;
    let rehomePid = 0;
    let finishRehome!: Promise<void>;
    try {
      const otherSubsidiaryId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other Carry In Entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));

      let signalReady!: () => void;
      const ready = new Promise<void>((resolve) => { signalReady = resolve });
      finishRehome = withBypassContext(() => db.transaction(async (tx) => {
        rehomePid = Number((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
        await tx.execute(sql`update parties set subsidiary_id = ${otherSubsidiaryId} where id = ${employeeId} and org_id = ${org.orgId}`);
        signalReady();
        await new Promise<void>((resolve) => { releaseRehome = resolve });
      }));
      await ready;
      const importing = resource.write([row("Rehomed Carry In", "250.00")], "insert", ctx);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await withBypassContext(() => db.execute(sql`
          select 1 from pg_stat_activity where ${rehomePid} = any(pg_blocking_pids(pid)) limit 1`));
        if (waiting.rows.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "the import save must wait for the concurrent employee rehome");
      releaseRehome();
      await finishRehome;
      const result = await importing;
      assert.equal(result.failed, 1);
      assert.equal(result.created, 0);
      assert.match(result.errors[0]!.message, /not found/i);
      assert.equal(await ledgerCount(org.orgId), 0);
    } finally {
      releaseRehome?.();
      await finishRehome;
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
