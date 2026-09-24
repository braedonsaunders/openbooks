import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import pg from "pg";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");
const {
  db,
  withBypassContext,
  withOrgTransaction,
} = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
const {
  projectCostSummary,
  projectTimeSummary,
  projectUnbilled,
} = await import("./project-costing.ts");
const {
  resolveProjectFinancials,
} = await import("@openbooks/engine/src/projects/financials.ts");
const {
  vendorComplianceStatus,
} = await import("@openbooks/engine/src/compliance/compliance.ts");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");

const DB = !!process.env.OPENBOOKS_DB_URL;

// PG-CONCURRENT-TX: one pg client serves one connection, so concurrent
// queries on a transaction-owned client interleave instead of parallelising
// (deprecated by pg, fatal in pg 9). This test wraps Client.query with a
// per-client in-flight counter and runs each sequenced loader inside a real
// transaction: any overlap fails. A deliberate concurrent pair first proves
// the detector itself observes overlap.

type QueryFn = (...args: unknown[]) => unknown;

function installOverlapDetector(): {
  max: () => number;
  reset: () => void;
  restore: () => void;
} {
  const proto = pg.Client.prototype as unknown as Record<string, unknown>;
  const original = proto["query"] as QueryFn;
  const inflight = new WeakMap<object, number>();
  let max = 0;
  const begin = (target: object): void => {
    const cur = (inflight.get(target) ?? 0) + 1;
    inflight.set(target, cur);
    if (cur > max) max = cur;
  };
  const finish = (target: object): void => {
    inflight.set(target, (inflight.get(target) ?? 1) - 1);
  };
  proto["query"] = function (this: object, ...args: unknown[]): unknown {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const callback = last as QueryFn;
      const wrapped = (...cb: unknown[]): unknown => {
        finish(this);
        return callback(...cb);
      };
      begin(this);
      try {
        return original.apply(this, [...args.slice(0, -1), wrapped]);
      } catch (error) {
        finish(this);
        throw error;
      }
    }
    begin(this);
    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (error) {
      finish(this);
      throw error;
    }
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as Promise<unknown>).then === "function"
    ) {
      return (result as Promise<unknown>).then(
        (value) => {
          finish(this);
          return value;
        },
        (error: unknown) => {
          finish(this);
          throw error;
        },
      );
    }
    finish(this);
    return result;
  };
  return {
    max: () => max,
    reset: () => {
      max = 0;
    },
    restore: () => {
      proto["query"] = original;
    },
  };
}

test("sequenced loaders never overlap queries on one transaction client", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const sov = BUILTIN_PROJECT_TYPES.find(
      (t) => t.key === "schedule_of_values",
    )!;
    const typeId = randomUUID();
    const projectId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',
          ${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`);
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
        values (${projectId},${org.orgId},${org.subsidiaryId},'TXSEQ','Overlap probe',${org.customerId},${typeId},'active',true)`);
    });

    const detector = installOverlapDetector();
    try {
      await withOrgTransaction(org.orgId, async () => {
        await Promise.all([
          db.execute(sql`select 1`),
          db.execute(sql`select 2`),
        ]);
      });
      assert.ok(
        detector.max() >= 2,
        `the detector must observe deliberate overlap (saw ${detector.max()})`,
      );

      detector.reset();
      const quietProject = randomUUID();
      await withOrgTransaction(org.orgId, async () => {
        await projectCostSummary(org.orgId, quietProject, null);
        await projectTimeSummary(org.orgId, quietProject);
        await projectUnbilled(org.orgId, quietProject);
      });
      assert.equal(
        detector.max(),
        1,
        `project costing loaders overlapped ${detector.max()} queries on one client`,
      );

      detector.reset();
      await withOrgTransaction(org.orgId, async () => {
        await resolveProjectFinancials(
          org.orgId,
          projectId,
          sov.financialProfile,
        );
      });
      assert.equal(
        detector.max(),
        1,
        `project financials overlapped ${detector.max()} queries on one client`,
      );

      detector.reset();
      await withOrgTransaction(org.orgId, async () => {
        await vendorComplianceStatus({
          orgId: org.orgId,
          partyId: randomUUID(),
        });
      });
      assert.equal(
        detector.max(),
        1,
        `compliance status overlapped ${detector.max()} queries on one client`,
      );
    } finally {
      detector.restore();
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
