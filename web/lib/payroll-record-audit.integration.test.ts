import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "./auth";
import { resolveAppModule } from "./test-module-hooks";
import { stubModules } from "../testing/stub-modules";

const sessionKey = Symbol.for("openbooks.payroll-record-audit-session");
const session: { user: SessionUser | null } = { user: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[sessionKey] = session;
const root = pathToFileURL(process.cwd() + "/").href;
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: { "server-only": "" },
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function currentUser(){return globalThis[Symbol.for("openbooks.payroll-record-audit-session")].user}',
      };
    }
    return resolveAppModule(specifier, context, next, root) ?? next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { seedAdoption, calculatedRun } =
  await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
const { createScratchUser, dropScratchOrgReporting } =
  await import("@openbooks/engine/testing/fixtures");
const { GET } = await import("../app/api/audit/record/route");

test(
  "payroll record history follows live payroll permission, feature and the complete run population",
  {
    skip: !process.env.OPENBOOKS_DB_URL,
  },
  async () => {
    const fx = await withBypassContext(() => seedAdoption());
    try {
      const { input } = await withOrgContext(fx.orgId, () => calculatedRun(fx));
      const calculationEvent = await withOrgContext(fx.orgId, () =>
        db.execute<{ id: string }>(
          sql`
      select id from audit_log where org_id=${fx.orgId} and table_name='pay_runs'
        and row_id=${input.documentId} and changes->>'operation'='calculate_pay_run'
    `,
          "objects",
        ),
      );
      assert.equal(calculationEvent.length, 1, "the native calculation retains its actual event");
      const eventId = randomUUID();
      const evidenceText =
        '{"before":{"document":{"kind":"pay_run","total":999999999999998.99}},"after":{"document":{"kind":"pay_run","total":999999999999999.00}},"reason":"Review the retained payroll transition"}';
      const evidence = {
        before: { document: { kind: "pay_run", total: "999999999999998.99" } },
        after: { document: { kind: "pay_run", total: "999999999999999.00" } },
        reason: "Review the retained payroll transition",
      };
      await withBypassContext(() =>
        db.execute(sql`
      insert into audit_log(id,org_id,table_name,row_id,action,changes,actor_id)
      values(${eventId},${fx.orgId},'documents',${input.documentId},'update',${evidenceText}::jsonb,${fx.actorId})
    `),
      );
      const reader = await withBypassContext(() =>
        createScratchUser(fx.orgId, "Payroll history reader", "payroll_history_reader"),
      );
      const setRole = async (permissions: string[], ids: string[]) => {
        await withBypassContext(() =>
          db.execute(sql`
        update app_roles set permissions=${JSON.stringify(permissions)}::jsonb,
          subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: ids })}::jsonb
        where org_id=${fx.orgId} and key='payroll_history_reader'
      `),
        );
      };
      session.user = {
        id: reader,
        orgId: fx.orgId,
        name: "Payroll history reader",
        email: "payroll-history@scratch.test",
        roles: [],
        isSuperAdmin: false,
        envKind: "production",
        productionOrgId: fx.orgId,
        homeOrgId: fx.orgId,
        homeUserId: reader,
      };
      const read = (id = input.documentId) =>
        withOrgContext(fx.orgId, () =>
          GET(new Request(`http://localhost/api/audit/record?table=documents&id=${id}`)),
        );
      const auditCount = async () =>
        (
          await withOrgContext(fx.orgId, () =>
            db.execute<{ n: string }>(
              sql`
      select count(*)::text n from audit_log where org_id=${fx.orgId}
    `,
              "objects",
            ),
          )
        )[0]!.n;
      const before = await auditCount();

      for (const permissions of [["ap.read"], ["gl.read"], ["ar.read"], []]) {
        await setRole(permissions, [fx.subsidiaryId]);
        const existing = await read();
        const missing = await read(randomUUID());
        assert.equal(existing.status, 404);
        assert.equal(missing.status, 404);
        assert.deepEqual(await existing.json(), await missing.json());
      }
      await setRole(["payroll.read"], [fx.subsidiaryId]);
      const own = await read();
      assert.equal(own.status, 200);
      const ownBody = await own.json();
      assert.equal(ownBody.recordType, "pay_run");
      assert.deepEqual(
        ownBody.rows.find((row: { id: string }) => row.id === eventId)?.changes,
        evidence,
      );
      const calculated = ownBody.rows.find(
        (row: { id: string }) => row.id === calculationEvent[0]!.id,
      );
      assert.equal(calculated?.changes.operation, "calculate_pay_run");
      assert.equal(calculated?.changes.event, "pay_run_calculated");
      assert.equal(calculated?.changes.after.run.documentId, input.documentId);

      await setRole(["payroll.read"], []);
      assert.equal((await read()).status, 404);
      await setRole(["payroll.read"], [fx.subsidiaryId]);
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings=jsonb_set(settings,'{features,payroll}','false'::jsonb) where id=${fx.orgId}
    `),
      );
      assert.equal((await read()).status, 404);
      await withBypassContext(() =>
        db.execute(sql`
      update orgs set settings=jsonb_set(settings,'{features,payroll}','true'::jsonb) where id=${fx.orgId}
    `),
      );

      const foreignEntity = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${foreignEntity},${fx.orgId},${fx.subsidiaryId},'Another legal employer','CAD','CA')`);
        await db.execute(
          sql`update parties set subsidiary_id=${foreignEntity} where org_id=${fx.orgId} and id=${fx.employeeId}`,
        );
      });
      const hiddenPopulation = await read();
      assert.equal(
        hiddenPopulation.status,
        404,
        "a visible run header cannot expose a hidden employee population",
      );
      assert.deepEqual(await hiddenPopulation.json(), { error: "not_found" });
      await setRole(["payroll.read"], [fx.subsidiaryId, foreignEntity]);
      assert.equal((await read()).status, 200);
      assert.equal(
        await auditCount(),
        before,
        "history reads append no audit or transaction events",
      );
    } finally {
      session.user = null;
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);
