import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedPayrollTime } =
  await import("@openbooks/engine/testing/fixtures");
const { seedAdoption, seedRoeIssuanceFixture } =
  await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
const { executeAssistantTool } = await import("../assistant/registry");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function contextFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Payroll test user",
        orgId,
        roles: [{ key: "payroll-role", name: "Payroll role" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function retainPayrollSource(orgId: string, actorId: string) {
  const fileId = randomUUID();
  const versionId = randomUUID();
  const folderId = randomUUID();
  const bytes = Buffer.from("Original source record for payroll reporting evidence");
  const { createHash } = await import("node:crypto");
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await db.execute(
        sql`
        insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
        values(${folderId},${orgId},'Payroll source evidence',true,${actorId},${actorId},${actorId}) returning id
      `,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`
        insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
        values(${fileId},${orgId},${folderId},'payroll-source.txt','text/plain',${bytes.length},${actorId},${actorId}) returning id
      `,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`
        insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
        values(${versionId},${fileId},1,${bytes.length},'text/plain',${sourceSha256},${actorId}) returning id
      `,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into file_blobs(version_id,bytes) values(${versionId},${bytes}) returning version_id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`
        update files set current_version_id=${versionId} where org_id=${orgId} and id=${fileId} returning id
      `,
        "objects",
      )
    ).length,
    1,
  );
  return { sourceFileId: fileId, sourceVersionId: versionId, sourceSha256 };
}

test(
  "payroll profile and pay-run commands save, calculate, replay, and verify through payroll reads",
  { skip: !DB },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    try {
      const context = contextFor(fixture.orgId, fixture.actorId, [
        "assistant.use",
        "payroll.manage",
        "payroll.run",
        "payroll.read",
      ]);
      const run = (name: string, input: Record<string, unknown>) =>
        executeApplicationTool(applicationTool(name)!, context, input);

      const profileInput = {
        employeePartyId: fixture.employeeId,
        payScheduleId: fixture.scheduleId,
        country: "CA",
        province: "ON",
        payBasis: "hourly",
        federalClaimCode: 1,
        provincialClaimCode: 1,
        wcbExempt: true,
        wcbExemptReason: "Payroll command integration fixture coverage exemption",
        idempotencyKey: "payroll-profile-0001",
      };
      const profile = await run("save_employee_payroll_profile", profileInput);
      assert.equal(profile.replayed, false);
      assert.equal(profile.employeePartyId, fixture.employeeId);
      assert.equal(Object.hasOwn(profile, "sin"), false);
      const profileReplay = await run("save_employee_payroll_profile", profileInput);
      assert.equal(profileReplay.replayed, true);
      const employees = await withOrgContext(fixture.orgId, () =>
        executeAssistantTool(context.authz, "list_payroll_employees", {
          query: fixture.employeeName,
        }),
      );
      assert.equal(employees.ok, true, JSON.stringify(employees));
      const employeeData = employees.data as { employees: Array<Record<string, unknown>> };
      assert.equal(employeeData.employees[0]?.employeePartyId, fixture.employeeId);
      assert.equal(Object.hasOwn(employeeData.employees[0]!, "sin"), false);

      await withBypassContext(() =>
        seedPayrollTime(fixture.orgId, fixture.employeeId, fixture.actorId, {
          workedOn: "2026-07-14",
          hours: "8",
          status: "approved",
          isBillable: false,
          billingStatus: "unbilled",
          costingBasis: "actual",
        }),
      );
      const createInput = {
        payScheduleId: fixture.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        idempotencyKey: "payroll-run-create-0001",
      };
      const created = await run("create_pay_run", createInput);
      assert.equal(created.replayed, false);
      const documentId = String(created.documentId);
      const replay = await run("create_pay_run", createInput);
      assert.equal(replay.replayed, true);
      assert.equal(replay.documentId, documentId);

      await run("calculate_pay_run", { documentId, idempotencyKey: "payroll-run-calc-0001" });
      const detail = await withOrgContext(fixture.orgId, () =>
        executeAssistantTool(context.authz, "get_pay_run", { documentId }),
      );
      assert.equal(detail.ok, true);
      const detailData = detail.data as { run: Record<string, unknown> };
      assert.equal(detailData.run.documentId, documentId);
      assert.equal(detailData.run.runStatus, "calculated");
    } finally {
      await withBypassContext(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "payroll commands enforce permission and the organization feature gate",
  { skip: !DB },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    try {
      const denied = contextFor(fixture.orgId, fixture.actorId, []);
      await assert.rejects(
        executeApplicationTool(applicationTool("save_employee_payroll_profile")!, denied, {
          employeePartyId: fixture.employeeId,
          payScheduleId: fixture.scheduleId,
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          idempotencyKey: "payroll-profile-denied",
        }),
        (error: unknown) => error instanceof Error && error.message === "forbidden",
      );

      await withBypassContext(() =>
        db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features,payroll}', 'false'::jsonb, true)
           where id = ${fixture.orgId}`),
      );
      const featureOff = contextFor(fixture.orgId, fixture.actorId, ["payroll.manage"]);
      await assert.rejects(
        executeApplicationTool(applicationTool("save_employee_payroll_profile")!, featureOff, {
          employeePartyId: fixture.employeeId,
          payScheduleId: fixture.scheduleId,
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          idempotencyKey: "payroll-profile-feature-off",
        }),
        (error: unknown) => error instanceof Error && "status" in error && error.status === 404,
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test("payroll profile writes cannot cross organization boundaries", { skip: !DB }, async () => {
  const fixture = await withBypassContext(() => seedAdoption());
  const otherOrg = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(otherOrg.orgId));
    const context = contextFor(otherOrg.orgId, actors.adminId, ["payroll.manage"]);
    await assert.rejects(
      executeApplicationTool(applicationTool("save_employee_payroll_profile")!, context, {
        employeePartyId: fixture.employeeId,
        payScheduleId: fixture.scheduleId,
        country: "CA",
        province: "ON",
        payBasis: "hourly",
        idempotencyKey: "payroll-profile-cross-org",
      }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 422 &&
        error.message === "employee is not available",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(otherOrg.orgId));
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test(
  "separation evidence commands record and read native facts, history, and subsequent service",
  { skip: !DB },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    try {
      await withBypassContext(() => seedRoeIssuanceFixture(fixture.orgId, fixture.employeeId));
      const filingAccountId = randomUUID();
      await withBypassContext(async () => {
        assert.equal(
          (
            await db.execute(
              sql`
              insert into payroll_filing_accounts
                (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
              values(${filingAccountId},${fixture.orgId},${fixture.subsidiaryId},'CA','ca_rp','123456789RP0001',
                'Payroll filing account','regular',true,true,${fixture.actorId},${fixture.actorId}) returning id
            `,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`
              update employee_payroll_profiles set filing_account_id=${filingAccountId}
              where org_id=${fixture.orgId} and employee_party_id=${fixture.employeeId} returning employee_party_id
            `,
              "objects",
            )
          ).length,
          1,
        );
      });
      const source = await withOrgContext(fixture.orgId, () =>
        retainPayrollSource(fixture.orgId, fixture.actorId),
      );
      const context = contextFor(fixture.orgId, fixture.actorId, ["payroll.run", "payroll.read"]);
      const run = (name: string, input: Record<string, unknown>) =>
        executeApplicationTool(applicationTool(name)!, context, input);
      await withOrgContext(fixture.orgId, async () => {
        const events = await db.execute<{ id: string }>(
          sql`
          select id from payroll_roe_separation_events
          where org_id=${fixture.orgId} and employee_party_id=${fixture.employeeId}
        `,
          "objects",
        );
        assert.equal(events.length, 1);
        const eventId = events[0]!.id;
        const subject = {
          employeePartyId: fixture.employeeId,
          employmentId: fixture.employmentId,
          subsidiaryId: fixture.subsidiaryId,
        };
        const facts = await run("get_employee_separation_facts", {
          employeePartyId: fixture.employeeId,
          eventId,
        });
        const current = facts.record as {
          firstDayWorked: string;
          interruptionOn: string;
          lastInsurableEarningsOn: string;
          salaryContinuanceEndOn: string | null;
          updatedAt: string;
        };
        assert.equal(current.interruptionOn, "2026-08-10");
        const factsInput = {
          ...subject,
          firstDayWorked: current.firstDayWorked,
          interruptionOn: current.interruptionOn,
          lastInsurableEarningsOn: current.lastInsurableEarningsOn,
          salaryContinuanceEndOn: current.salaryContinuanceEndOn,
          sourceReference: "Original employee separation declaration",
          reason: "Confirm the source-backed employment interruption",
          status: "confirmed",
          expectedId: eventId,
          expectedUpdatedAt: current.updatedAt,
          idempotencyKey: "payroll-separation-facts-01",
        };
        const recordedFacts = await run("record_employee_separation_facts", factsInput);
        assert.equal(recordedFacts.replayed, false);
        const factsReplay = await run("record_employee_separation_facts", factsInput);
        assert.equal(factsReplay.replayed, true);
        const factsAfter = await run("get_employee_separation_facts", {
          employeePartyId: fixture.employeeId,
          eventId,
        });
        assert.equal(
          (factsAfter.record as { sourceReference: string }).sourceReference,
          factsInput.sourceReference,
        );

        const historyInput = {
          ...subject,
          kind: "period",
          evidence: {
            ...source,
            sourceReference: "Original employer reporting record",
            insuranceReference: "Original insurable earnings record",
            hoursReference: "Original paid hours record",
            reason: "Retain the prior reporting period from the source",
            filingAccountId,
            payScheduleId: fixture.scheduleId,
            frequency: "biweekly",
            periodStart: "2026-03-29",
            periodEnd: "2026-04-11",
            payDate: "2026-04-15",
            earnedFrom: "2026-03-30",
            earnedTo: "2026-04-03",
            insurableEarnings: "80",
            insurableHours: "4",
            nilPeriod: false,
            expectedId: null,
            expectedUpdatedAt: null,
          },
          idempotencyKey: "payroll-separation-history-01",
        };
        const historyRecord = await run("record_separation_history", historyInput);
        assert.equal(historyRecord.replayed, false);
        const historyReplay = await run("record_separation_history", historyInput);
        assert.equal(historyReplay.replayed, true);
        const history = await run("get_separation_history", subject);
        assert.equal((history.periods as Array<{ id: string }>).length, 1);
        assert.equal(
          (history.periods as Array<{ id: string }>)[0]!.id,
          (historyRecord.record as { id: string }).id,
        );

        const subsequentInput = {
          ...subject,
          precedingEventId: eventId,
          firstDayWorked: "2026-08-11",
          ...source,
          sourceReference: "Original signed return declaration",
          reason: "Retain actual return-to-service evidence",
          expectedId: null,
          expectedUpdatedAt: null,
          idempotencyKey: "payroll-subsequent-service-01",
        };
        const subsequent = await run("record_subsequent_service", subsequentInput);
        assert.equal(subsequent.replayed, false);
        const subsequentReplay = await run("record_subsequent_service", subsequentInput);
        assert.equal(subsequentReplay.replayed, true);
        const subsequentRead = await run("get_subsequent_service", {
          ...subject,
          precedingEventId: eventId,
        });
        assert.equal(
          (subsequentRead.record as { firstDayWorked: string }).firstDayWorked,
          "2026-08-11",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrg(fixture.orgId));
    }
  },
);
