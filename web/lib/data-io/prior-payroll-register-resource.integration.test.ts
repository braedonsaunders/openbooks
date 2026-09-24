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
// before the hooks run and throw. Same pattern as the other data-io suites.
const { priorPayrollRegisterResource } = (await import(
  "./prior-payroll-register-resource.ts"
)) as typeof import("./prior-payroll-register-resource.ts");
hooks.deregister();

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} = await import("@openbooks/engine/src/testing/fixtures.ts");

test("prior register imports refuse when the caller scope is missing", async () => {
  const resource = priorPayrollRegisterResource("scope-required-org");
  await assert.rejects(
    resource.write([], "insert", {
      orgId: "scope-required-org",
      actorId: "scope-required-actor",
      dryRun: false,
    }),
    /requires an explicit subsidiary scope/,
  );
});

/**
 * The prior-payroll-register resource ran NO date or amount validation in its
 * dry-run branch, and committed the register header BEFORE the stub save that
 * actually validates. So the wizard preview accepted a bad-ISO date, a
 * decimal-comma amount, and a reversed period as "1 created", while the
 * commit refused the row — and the refused row still left an empty register
 * header (with no stubs) behind.
 *
 * The resource now runs the engine's own preflight
 * (`preflightPriorRegisterRow`) per row in BOTH modes, before any header is
 * written: preview and commit refuse exactly the same rows with the exact
 * same message, and a refused row writes no header, no stub, and no audit
 * row. Per-row, so one bad row still does not fail its neighbours.
 *
 * DB partition: scratch orgs, synthetic data only, no DDL.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

// Seed writes run inside an explicit bypass scope: this file eagerly imports
// a web reader, which replaces the test bypass resolver, so a bare insert
// would reach RLS-governed tables unscoped.
async function seedComponent(orgId: string, code: string): Promise<void> {
  return withBypassContext(async () => {
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, basis, sequence, is_active)
      values (${randomUUID()}, ${orgId}, ${code}, ${code}, 'earning', 'fixed_amount', 100, true)`);
  });
}

async function seedEmployee(orgId: string, actorId: string, name: string): Promise<void> {
  return withBypassContext(async () => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${id}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (org_id, party_id, hired_on, terminated_on, is_active,
                                 created_by, updated_by)
      values (${orgId}, ${id}, '2016-01-06', null, true, ${actorId}, ${actorId})`);
  });
}

async function tableCount(orgId: string, table: "payroll_prior_registers" | "payroll_prior_stubs"): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ${sql.raw(`public.${table}`)} where org_id = ${orgId}`));
  return rows.rows[0]!.n;
}

async function stubCountFor(orgId: string, label: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from payroll_prior_stubs
     where org_id = ${orgId} and employee_label = ${label}`));
  return rows.rows[0]!.n;
}

async function priorAuditCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and table_name in ('payroll_prior_registers', 'payroll_prior_stubs')`));
  return rows.rows[0]!.n;
}

function row(register: string, employee: string, overrides: Record<string, unknown> = {}) {
  return {
    register,
    providerName: "PriorCo",
    employee,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
    payDate: "2026-07-21",
    "total:gross": "5000.00",
    "total:net_pay": "3800.00",
    SALARY: "5000.00",
    ...overrides,
  };
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  await seedComponent(org.orgId, "SALARY");
  await seedEmployee(org.orgId, actorId, "Robin Field");
  await seedEmployee(org.orgId, actorId, "Aldo Rossi");
  const resource = priorPayrollRegisterResource(org.orgId);
  const ctxFor = (dryRun: boolean) => ({
    orgId: org.orgId,
    actorId,
    dryRun,
    allowedSubsidiaryIds: null,
  });
  return { org, actorId, resource, ctxFor };
}

test(
  "prior register preview and commit refuse a bad-ISO date with the same message, writing nothing",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const bad = row("Prior provider — 2026-07", "Robin Field", { periodStart: "2026-13-01" });
      const preview = await f.resource.write([bad], "insert", f.ctxFor(true));
      assert.equal(preview.failed, 1, "dry run accepted a bad-ISO date");
      assert.equal(preview.created, 0);
      assert.equal(preview.updated, 0);
      assert.match(preview.errors[0]!.message, /periodStart must be a date \(YYYY-MM-DD\)/);

      const refused = await f.resource.write([bad], "insert", f.ctxFor(false));
      assert.equal(refused.failed, 1);
      assert.equal(refused.created, 0);
      assert.equal(refused.updated, 0);
      assert.equal(
        refused.errors[0]!.message,
        preview.errors[0]!.message,
        "commit must refuse with the exact preview message",
      );

      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 0);
      assert.equal(await tableCount(f.org.orgId, "payroll_prior_stubs"), 0);
      assert.equal(await priorAuditCount(f.org.orgId), 0);
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);

test(
  "prior register preview and commit refuse an impossible calendar date, writing nothing",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      // "2026-02-30" matches YYYY-MM-DD shape but names no day; a shape-only
      // check waves it through to the database.
      const bad = row("Prior provider — 2026-02", "Robin Field", { periodStart: "2026-02-30" });
      const preview = await f.resource.write([bad], "insert", f.ctxFor(true));
      assert.equal(preview.failed, 1, "dry run accepted an impossible calendar date");
      assert.match(preview.errors[0]!.message, /periodStart must be a date \(YYYY-MM-DD\)/);

      const refused = await f.resource.write([bad], "insert", f.ctxFor(false));
      assert.equal(refused.failed, 1);
      assert.equal(refused.errors[0]!.message, preview.errors[0]!.message);

      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 0);
      assert.equal(await tableCount(f.org.orgId, "payroll_prior_stubs"), 0);
      assert.equal(await priorAuditCount(f.org.orgId), 0);
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);

test(
  "prior register preview and commit refuse decimal-comma totals AND components, writing nothing",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      for (const bad of [
        row("Prior provider — 2026-07", "Robin Field", { "total:gross": "12,34" }),
        row("Prior provider — 2026-07", "Robin Field", { SALARY: "12,34" }),
      ]) {
        const preview = await f.resource.write([bad], "insert", f.ctxFor(true));
        assert.equal(preview.failed, 1, "dry run accepted a decimal-comma amount");
        assert.match(preview.errors[0]!.message, /must use "\." as the decimal point/);

        const refused = await f.resource.write([bad], "insert", f.ctxFor(false));
        assert.equal(refused.failed, 1);
        assert.equal(refused.errors[0]!.message, preview.errors[0]!.message);
      }

      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 0);
      assert.equal(await tableCount(f.org.orgId, "payroll_prior_stubs"), 0);
      assert.equal(await priorAuditCount(f.org.orgId), 0);
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);

test(
  "prior register preview and commit refuse a reversed period, writing nothing",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const bad = row("Prior provider — 2026-07", "Robin Field", {
        periodStart: "2026-07-18",
        periodEnd: "2026-07-05",
      });
      const preview = await f.resource.write([bad], "insert", f.ctxFor(true));
      assert.equal(preview.failed, 1, "dry run accepted a reversed period");
      assert.match(preview.errors[0]!.message, /periodEnd cannot fall before periodStart/);

      const refused = await f.resource.write([bad], "insert", f.ctxFor(false));
      assert.equal(refused.failed, 1);
      assert.equal(refused.errors[0]!.message, preview.errors[0]!.message);

      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 0);
      assert.equal(await tableCount(f.org.orgId, "payroll_prior_stubs"), 0);
      assert.equal(await priorAuditCount(f.org.orgId), 0);
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);

test(
  "prior register control row previews and commits cleanly",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      const preview = await f.resource.write(
        [row("Prior provider — 2026-07", "Robin Field")],
        "insert",
        f.ctxFor(true),
      );
      assert.deepEqual(preview.errors, []);
      assert.equal(preview.created, 1);
      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 0);

      const committed = await f.resource.write(
        [row("Prior provider — 2026-07", "Robin Field")],
        "insert",
        f.ctxFor(false),
      );
      assert.deepEqual(committed.errors, []);
      assert.equal(committed.created, 1);
      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 1);
      assert.equal(await stubCountFor(f.org.orgId, "Robin Field"), 1);
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);

test(
  "prior register mixed file keeps honest counts: good row lands, bad row leaves no trace",
  { skip: !DB },
  async () => {
    const f = await fixture();
    try {
      // Bad row FIRST: under the old order (header upsert before stub save)
      // the refusal still created the register shell.
      const committed = await f.resource.write(
        [
          row("Prior provider — 2026-07", "Robin Field", { "total:gross": "12,34" }),
          row("Prior provider — 2026-07", "Aldo Rossi"),
        ],
        "insert",
        f.ctxFor(false),
      );
      assert.equal(committed.created, 1);
      assert.equal(committed.failed, 1);
      assert.equal(committed.errors.length, 1);
      assert.equal(committed.errors[0]!.row, 1);
      assert.match(committed.errors[0]!.message, /must use "\." as the decimal point/);

      assert.equal(await tableCount(f.org.orgId, "payroll_prior_registers"), 1);
      assert.equal(await stubCountFor(f.org.orgId, "Aldo Rossi"), 1);
      assert.equal(await stubCountFor(f.org.orgId, "Robin Field"), 0);
      assert.equal(await priorAuditCount(f.org.orgId), 1);
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);
