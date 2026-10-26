import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPayrollSettings,
} from "@openbooks/engine/testing/fixtures";
import { createSetupRecord, updateSetupRecord } from "./write.ts";
import { setupResource } from "../data-io/setup-resources.ts";
import { SETUP_ENTITY_BY_KEY } from "./registry.ts";

test(
  "component reasons remain audited through create, replay, update and dated policy writes",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const user = await withBypass(() =>
        createScratchUser(org.orgId, "Payroll administrator", "admin"),
      );
      await withBypass(() =>
        seedPayrollSettings(org.orgId, {
          features: { payroll: true },
          payroll: { countries: ["CA"] },
        }),
      );
      const actor = { orgId: org.orgId, id: user, permissions: ["*"] };
      const requestId = randomUUID();
      const body = {
        code: "REASON",
        name: "Reviewed earning",
        kind: "earning",
        country: "CA",
        value: "10",
        reason: "  Approved earning classification  ",
      };
      const create = (input: Record<string, unknown>) =>
        withBypass(() => createSetupRecord(actor, "pay-components", input, { requestId }));
      const evidence = async (id: string, action: string) =>
        (
          await withBypass(() =>
            db.execute<{ changes: Record<string, unknown> }>(
              sql`
      select changes from audit_log where org_id = ${org.orgId} and row_id = ${id} and action = ${action} order by at desc limit 1
    `,
              "objects",
            ),
          )
        )[0]!.changes;

      const created = await create(body);
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const componentId = (created.body as { id: string }).id;
      const insertEvidence = await evidence(componentId, "insert");
      assert.equal(insertEvidence.reason, "Approved earning classification");
      assert.equal((insertEvidence.after as Record<string, unknown>).name, body.name);
      assert.equal(Object.hasOwn(insertEvidence.after as object, "reason"), false);
      assert.equal((await create(body)).status, 200);
      assert.equal(
        (await create({ ...body, reason: "A different classification decision" })).status,
        409,
      );

      const treatment = (
        await withBypass(() =>
          db.execute<{ id: string }>(
            sql`
      select id from pay_component_statutory_treatments where org_id = ${org.orgId} and pay_component_id = ${componentId}
    `,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        (await evidence(treatment.id, "insert")).reason,
        "Initial statutory treatment created with the pay component.",
      );

      const updated = await withBypass(() =>
        updateSetupRecord(actor, "pay-components", {
          id: componentId,
          name: "Reclassified earning",
          reason: "  Approved classification correction  ",
        }),
      );
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      const updateEvidence = await evidence(componentId, "update");
      assert.equal(updateEvidence.reason, "Approved classification correction");
      assert.equal((updateEvidence.before as Record<string, unknown>).name, body.name);
      assert.equal((updateEvidence.after as Record<string, unknown>).name, "Reclassified earning");
      for (const reason of [null, 12, {}, "", " ", "x".repeat(2001)]) {
        const refused = await withBypass(() =>
          updateSetupRecord(actor, "pay-components", {
            id: componentId,
            name: "Invalid change",
            reason,
          }),
        );
        assert.equal(refused.status, 400);
      }
      assert.deepEqual(await evidence(componentId, "update"), updateEvidence);

      const closeBody = { id: treatment.id, effectiveTo: "2099-12-31" };
      const missingReason = await withBypass(() =>
        updateSetupRecord(actor, "pay-component-statutory-treatments", closeBody),
      );
      assert.equal(missingReason.status, 400);
      const closed = await withBypass(() =>
        updateSetupRecord(actor, "pay-component-statutory-treatments", {
          ...closeBody,
          reason: "Replace the vacation-base policy from 2100",
        }),
      );
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(
        (await evidence(treatment.id, "update")).reason,
        "Replace the vacation-base policy from 2100",
      );

      const policyBody = {
        payComponentId: componentId,
        effectiveFrom: "2100-01-01",
        programExclusions: [],
        vacationable: false,
      };
      const missingCreateReason = await withBypass(() =>
        createSetupRecord(actor, "pay-component-statutory-treatments", policyBody),
      );
      assert.equal(missingCreateReason.status, 400);
      const policy = await withBypass(() =>
        createSetupRecord(actor, "pay-component-statutory-treatments", {
          ...policyBody,
          reason: "Approved exclusion from the vacation base",
        }),
      );
      assert.equal(policy.status, 200, JSON.stringify(policy.body));
      const policyEvidence = await evidence((policy.body as { id: string }).id, "insert");
      assert.equal(policyEvidence.reason, "Approved exclusion from the vacation base");
      assert.equal((policyEvidence.after as Record<string, unknown>).vacationable, false);
      assert.equal(Object.hasOwn(policyEvidence.after as object, "reason"), false);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "component imports retain audit reasons and create the same dated vacation policy",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const user = await withBypass(() =>
        createScratchUser(org.orgId, "Payroll administrator", "admin"),
      );
      await withBypass(() =>
        seedPayrollSettings(org.orgId, {
          features: { payroll: true },
          payroll: { countries: ["CA"] },
        }),
      );
      const resource = setupResource(SETUP_ENTITY_BY_KEY.get("pay-components")!, org.orgId);
      const context = {
        orgId: org.orgId,
        actorId: user,
        dryRun: false,
        permissions: new Set(["*"]),
      };
      const body = {
        code: "IMPORT-REASON",
        name: "Non-vacation earning",
        kind: "earning",
        country: "CA",
        value: "10",
        vacationable: false,
        reason: "  Approved separate vacation treatment  ",
      };
      assert.ok(
        (await withBypass(() => resource.fields())).some((field) => field.key === "reason"),
      );
      assert.equal(
        (await withBypass(() => resource.columns())).some((column) => column.key === "reason"),
        false,
      );
      const write = await withBypass(() => resource.write([body], "insert", context));
      assert.deepEqual(
        { created: write.created, updated: write.updated, failed: write.failed },
        { created: 1, updated: 0, failed: 0 },
        JSON.stringify(write),
      );
      const component = (
        await withBypass(() =>
          db.execute<{ id: string }>(
            sql`
      select id from pay_components where org_id=${org.orgId} and code=${body.code}
    `,
            "objects",
          ),
        )
      )[0]!;
      const policy = await withBypass(() =>
        db.execute<{ id: string; vacationable: boolean }>(
          sql`
      select id,vacationable from pay_component_statutory_treatments
      where org_id=${org.orgId} and pay_component_id=${component.id}
    `,
          "objects",
        ),
      );
      assert.equal(policy.length, 1);
      assert.equal(policy[0]!.vacationable, false);
      const audit = await withBypass(() =>
        db.execute<{
          actor_id: string;
          changes: { reason: string; after: Record<string, unknown> };
        }>(
          sql`
      select actor_id,changes from audit_log where org_id=${org.orgId}
        and table_name='pay_components' and row_id=${component.id} and action='insert'
    `,
          "objects",
        ),
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actor_id, user);
      assert.equal(audit[0]!.changes.reason, body.reason.trim());
      assert.equal(Object.hasOwn(audit[0]!.changes.after, "reason"), false);
      const refused = await withBypass(() =>
        resource.write([{ ...body, vacationable: true }], "upsert", context),
      );
      assert.equal(refused.failed, 1);
      assert.equal(refused.updated, 0);
      assert.match(
        refused.errors[0]!.message,
        /creation-only.*dated component statutory treatment/,
      );
      assert.deepEqual(
        await withBypass(() =>
          db.execute(
            sql`
      select id,vacationable from pay_component_statutory_treatments
      where org_id=${org.orgId} and pay_component_id=${component.id}
    `,
            "objects",
          ),
        ),
        policy,
      );
      const treatmentResource = setupResource(
        SETUP_ENTITY_BY_KEY.get("pay-component-statutory-treatments")!,
        org.orgId,
      );
      assert.equal(
        (await withBypass(() => treatmentResource.fields())).find((field) => field.key === "reason")
          ?.required,
        true,
      );
      assert.equal(
        (await withBypass(() => treatmentResource.columns())).some(
          (column) => column.key === "reason",
        ),
        false,
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "setup imports separate adoption audit reasons from stored service history",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Payroll administrator", "admin"),
      );
      await withBypass(() => seedPayrollSettings(org.orgId, { features: { payroll: true } }));
      const { seedPerson } = await import("@openbooks/engine/testing/hrm-harness");
      const person = await withBypass(() =>
        seedPerson(org.orgId, org.subsidiaryId, "Service recipient"),
      );
      const resource = setupResource(
        SETUP_ENTITY_BY_KEY.get("payroll-service-credits")!,
        org.orgId,
      );
      assert.equal(
        (await withBypass(() => resource.fields())).some((field) => field.key === "auditReason"),
        true,
      );
      assert.equal(
        (await withBypass(() => resource.columns())).some((column) => column.key === "auditReason"),
        false,
      );
      const body = {
        employmentId: person.employmentId,
        convention: "calendar_months",
        asOfDate: "2026-01-01",
        creditedMonths: "12",
        effectiveFrom: "2026-01-01",
        reason: "Historical credited-service agreement",
        auditReason: "  Approved adoption of retained service history  ",
      };
      const context = { orgId: org.orgId, actorId, permissions: new Set(["*"]), dryRun: false };
      const result = await withBypass(() => resource.write([body], "insert", context));
      assert.equal(result.created, 1, JSON.stringify(result));
      assert.equal(result.failed, 0, JSON.stringify(result));
      const stored = (
        await withBypass(() =>
          db.execute<{ id: string; reason: string }>(
            sql`
      select id,reason from payroll_service_credits where org_id=${org.orgId} and employment_id=${person.employmentId}
    `,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(stored.reason, body.reason);
      const evidence = await withBypass(() =>
        db.execute<{ changes: { reason: string; after: { reason: string } } }>(
          sql`
      select changes from audit_log where org_id=${org.orgId} and table_name='payroll_service_credits'
        and row_id=${stored.id} and actor_id=${actorId} and action='insert'
    `,
          "objects",
        ),
      );
      const adoption = evidence.filter((row) => row.changes.reason === body.auditReason.trim());
      assert.equal(adoption.length, 1);
      assert.equal(adoption[0]!.changes.after.reason, body.reason);
      for (const auditReason of [null, 12, {}, "", "  ", "x".repeat(2001)]) {
        const refused = await withBypass(() =>
          resource.write(
            [{ ...body, asOfDate: "2027-01-01", effectiveFrom: "2027-01-01", auditReason }],
            "insert",
            context,
          ),
        );
        assert.equal(refused.failed, 1);
        assert.equal(refused.created, 0);
        assert.match(refused.errors[0]!.message, /change reason/);
      }
      assert.equal(
        (
          await withBypass(() =>
            db.execute(
              sql`select id from payroll_service_credits where org_id=${org.orgId}`,
              "objects",
            ),
          )
        ).length,
        1,
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
