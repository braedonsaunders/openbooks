import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedPayrollSettings } =
  await import("@openbooks/engine/testing/fixtures");
const { setupResource } = await import("./setup-resources.ts");
const { SETUP_ENTITY_BY_KEY } = await import("../setup/registry.ts");

const auth = { gate: null as null | { user: { orgId: string; id: string } } };
Object.assign(globalThis, { __bookPolicyProbe: auth });
registerHooks({
  resolve(specifier, context, next) {
    // The route factory imports the exact alias lazily at request time from its own module URL, so it never matches the route-directory guard below: match it exactly so the factory gate uses this test's session.
    if (
      specifier === "@/lib/authz" ||
      (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/setup/"))
    )
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function guardPermission(){return globalThis.__bookPolicyProbe.gate}",
      };
    return next(specifier, context);
  },
});
const { POST, PATCH } = await import("../../app/api/admin/setup/[entity]/route.ts");

for (const operation of ["create", "update"] as const) {
  for (const channel of ["interactive", "import"] as const) {
    test(
      `${channel} setup ${operation} preserves declared earning defaults`,
      { skip: !process.env.OPENBOOKS_DB_URL },
      async () => {
        const org = await createScratchOrg();
        try {
          const actorId = (await seedFlowActors(org.orgId)).adminId;
          auth.gate = { user: { orgId: org.orgId, id: actorId } };
          const body: Record<string, unknown> = {
            code: "DEFAULT-FLAGS",
            name: "Default taxable earning",
            kind: "earning",
            value: "10",
            isActive: true,
            programExclusions: [],
            reason: "Approved new earning configuration",
          };
          if (operation === "update") {
            const created = (
              await db.execute(
                sql`insert into pay_components(org_id,code,name,kind,value,is_active,created_by,updated_by) values(${org.orgId},'DEFAULT-FLAGS','Original earning','earning','10',true,${actorId},${actorId}) returning id`,
                "objects",
              )
            )[0]!;
            await db.execute(
              sql`insert into pay_component_statutory_treatments(org_id,pay_component_id,effective_from,program_exclusions,vacationable,created_by,updated_by) values(${org.orgId},${created.id},current_date,'{}'::text[],true,${actorId},${actorId})`,
            );
            body.id = created.id;
          }
          if (channel === "interactive") {
            const response = await (operation === "create" ? POST : PATCH)(
              new Request("http://audit.local/api/admin/setup/pay-components", {
                method: operation === "create" ? "POST" : "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  ...(operation === "create" ? { "Idempotency-Key": randomUUID() } : {}),
                },
                body: JSON.stringify(body),
              }),
              { params: Promise.resolve({ entity: "pay-components" }) },
            );
            assert.equal(response.status, 200, JSON.stringify(await response.json()));
          } else {
            const outcome = await setupResource(
              SETUP_ENTITY_BY_KEY.get("pay-components")!,
              org.orgId,
            ).write([body], operation === "create" ? "insert" : "upsert", {
              orgId: org.orgId,
              actorId,
              dryRun: false,
            });
            assert.equal(
              operation === "create" ? outcome.created : outcome.updated,
              1,
              JSON.stringify(outcome),
            );
          }
          const stored = (
            await db.execute(
              sql`select taxable,pensionable,insurable,vacationable,include_in_disposable_earnings from pay_components where org_id=${org.orgId} and code='DEFAULT-FLAGS'`,
              "objects",
            )
          )[0];
          assert.deepEqual(stored, {
            taxable: true,
            pensionable: true,
            insurable: true,
            vacationable: true,
            include_in_disposable_earnings: true,
          });
          const treatment = (
            await db.execute(
              sql`select program_exclusions,t.vacationable from pay_component_statutory_treatments t
     join pay_components c on c.org_id=t.org_id and c.id=t.pay_component_id
     where c.org_id=${org.orgId} and c.code='DEFAULT-FLAGS' and t.effective_from<=current_date
       and (t.effective_to is null or t.effective_to>=current_date)`,
              "objects",
            )
          )[0];
          assert.deepEqual(treatment, { program_exclusions: [], vacationable: true });
          const evidence = await db.execute<{
            actor_id: string;
            changes: { after: Record<string, unknown>; reason: string };
          }>(
            sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='pay_components' and changes->'after'->>'code'='DEFAULT-FLAGS'`,
            "objects",
          );
          assert.equal(evidence.length, 1);
          assert.equal(evidence[0]!.actor_id, actorId);
          assert.equal(evidence[0]!.changes.reason, body.reason);
          for (const [key, value] of Object.entries(stored!))
            assert.deepEqual(evidence[0]!.changes.after[key], value);
        } finally {
          auth.gate = null;
          await dropScratchOrg(org.orgId);
        }
      },
    );
  }
}

for (const channel of ["interactive", "import"] as const) {
  test(
    `${channel} setup refuses malformed earning boolean controls`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const org = await createScratchOrg();
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId;
        auth.gate = { user: { orgId: org.orgId, id: actorId } };
        const body = {
          code: "INVALID-FLAG",
          name: "Malformed earning",
          kind: "earning",
          value: "10",
          isActive: true,
          taxable: "false-ish",
          pensionable: true,
          insurable: true,
          vacationable: true,
          includeInDisposableEarnings: true,
        };
        if (channel === "interactive") {
          const response = await POST(
            new Request("http://audit.local/api/admin/setup/pay-components", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
              body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ entity: "pay-components" }) },
          );
          assert.equal(response.status, 400, JSON.stringify(await response.json()));
        } else {
          const outcome = await setupResource(
            SETUP_ENTITY_BY_KEY.get("pay-components")!,
            org.orgId,
          ).write([body], "insert", { orgId: org.orgId, actorId, dryRun: false });
          assert.equal(outcome.created, 0, JSON.stringify(outcome));
          assert.equal(outcome.failed, 1);
        }
      } finally {
        auth.gate = null;
        await dropScratchOrg(org.orgId);
      }
    },
  );
}

for (const operation of ["create", "update"] as const) {
  for (const channel of ["interactive", "import"] as const) {
    test(
      `${channel} ${operation} preserves explicit earning exemptions`,
      { skip: !process.env.OPENBOOKS_DB_URL },
      async () => {
        const org = await createScratchOrg();
        try {
          const actorId = (await seedFlowActors(org.orgId)).adminId;
          auth.gate = { user: { orgId: org.orgId, id: actorId } };
          const body: Record<string, unknown> = {
            code: "EXPLICIT-FLAGS",
            name: "Explicit configuration",
            kind: "earning",
            value: "10",
            isActive: true,
            taxable: false,
            pensionable: false,
            insurable: false,
            vacationable: false,
            includeInDisposableEarnings: false,
          };
          if (operation === "update") {
            body.id = (
              await db.execute(
                sql`insert into pay_components(org_id,code,name,kind,value,created_by,updated_by) values(${org.orgId},'EXPLICIT-FLAGS','Original','earning','10',${actorId},${actorId}) returning id`,
                "objects",
              )
            )[0]!.id;
            delete body.vacationable;
          }
          if (channel === "interactive") {
            const response = await (operation === "create" ? POST : PATCH)(
              new Request("http://audit.local/api/admin/setup/pay-components", {
                method: operation === "create" ? "POST" : "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  ...(operation === "create" ? { "Idempotency-Key": randomUUID() } : {}),
                },
                body: JSON.stringify(body),
              }),
              { params: Promise.resolve({ entity: "pay-components" }) },
            );
            assert.equal(response.status, 200, JSON.stringify(await response.json()));
          } else {
            const outcome = await setupResource(
              SETUP_ENTITY_BY_KEY.get("pay-components")!,
              org.orgId,
            ).write([body], operation === "create" ? "insert" : "upsert", {
              orgId: org.orgId,
              actorId,
              dryRun: false,
            });
            assert.equal(
              operation === "create" ? outcome.created : outcome.updated,
              1,
              JSON.stringify(outcome),
            );
          }
          const stored = (
            await db.execute(
              sql`select taxable,pensionable,insurable,vacationable,include_in_disposable_earnings from pay_components where org_id=${org.orgId} and code='EXPLICIT-FLAGS'`,
              "objects",
            )
          )[0];
          assert.deepEqual(stored, {
            taxable: false,
            pensionable: false,
            insurable: false,
            vacationable: operation === "update",
            include_in_disposable_earnings: false,
          });
        } finally {
          auth.gate = null;
          await dropScratchOrg(org.orgId);
        }
      },
    );
  }
}

for (const channel of ["interactive", "import"] as const) {
  for (const declaredMembership of [undefined, true, false]) {
    test(
      `${channel} deduction creation preserves explicit protected-base membership`,
      { skip: !process.env.OPENBOOKS_DB_URL },
      async () => {
        const org = await createScratchOrg();
        try {
          const actorId = (await seedFlowActors(org.orgId)).adminId;
          auth.gate = { user: { orgId: org.orgId, id: actorId } };
          await seedPayrollSettings(org.orgId, {
            features: { payroll: true },
            payroll: { countries: ["CA"] },
          });
          const body = {
            code: "DEDUCTION-MEMBERSHIP",
            name: "Reviewed deduction",
            kind: "deduction",
            country: "CA",
            value: "10",
            ...(declaredMembership === undefined
              ? {}
              : { includeInDisposableEarnings: declaredMembership }),
            reason: "Approved protected-base classification",
          };
          if (channel === "interactive") {
            const response = await POST(
              new Request("http://audit.local/api/admin/setup/pay-components", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
                body: JSON.stringify(body),
              }),
              { params: Promise.resolve({ entity: "pay-components" }) },
            );
            assert.equal(response.status, 200, JSON.stringify(await response.json()));
          } else {
            const outcome = await setupResource(
              SETUP_ENTITY_BY_KEY.get("pay-components")!,
              org.orgId,
            ).write([body], "insert", { orgId: org.orgId, actorId, dryRun: false });
            assert.equal(outcome.created, 1, JSON.stringify(outcome));
            assert.equal(outcome.failed, 0);
          }
          const stored = (
            await db.execute<{ id: string; include_in_disposable_earnings: boolean }>(
              sql`select id,include_in_disposable_earnings from pay_components where org_id=${org.orgId} and code=${body.code}`,
              "objects",
            )
          )[0]!;
          assert.equal(stored.include_in_disposable_earnings, declaredMembership ?? false);
          const audit = await db.execute<{
            changes: { reason: string; after: { include_in_disposable_earnings: boolean } };
          }>(
            sql`select changes from audit_log where org_id=${org.orgId} and row_id=${stored.id} and action='insert' and table_name='pay_components'`,
            "objects",
          );
          assert.equal(audit.length, 1);
          assert.equal(
            audit[0]!.changes.after.include_in_disposable_earnings,
            declaredMembership ?? false,
          );
          assert.equal(audit[0]!.changes.reason, body.reason);
        } finally {
          auth.gate = null;
          await dropScratchOrg(org.orgId);
        }
      },
    );
  }
}
