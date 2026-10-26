import { captureFieldTicketLaborEvidence } from "../projects/field-ticket-labor-evidence.ts";
import { recordProgress, reverseProgress } from "../projects/progress.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { mondayOfIsoWeek } from "../platform/civil-date.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { INDUSTRY_STOCK } from "./industry-detail.ts";
import { sampleOperatingPolicy } from "./policy.ts";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import { createTrainingCourse } from "../hrm/training/store.ts";
import { savePattern } from "../schedule-boards/pattern-store.ts";
import { saveAttendanceDevice } from "../schedule-boards/attendance.ts";
import { createCompensationPackage } from "../payroll/compensation-package-store.ts";
import { moveConsignment } from "../inventory/consignment.ts";
import { recordSupplyEvidence } from "../tax/cross-border-records.ts";
import { saveQuoteTerm } from "../billing/quote-to-cash.ts";
import { ensureFiling } from "../compliance/information-returns.ts";
import { sampleCompanyFeatures, sampleRosterCopy } from "./features.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

/** Domain writers own governed drafts, custody evidence and quote valuation. */
export async function installFeatureWorkflows(c: DemoContext): Promise<void> {
  const f = sampleCompanyFeatures(c.industryKey);
  const id = (table: string, key = "main") => scenarioRecordId(c, table, key);
  const actor = { orgId: c.orgId, actorId: c.actorId };
  const reason = "Prepare synthetic industry demonstration for native operational review";
  if (f.hrmTraining || f.hrmShiftPlanning) {
    const user = (
      await db.execute<{ name: string; partyId: string | null }>(
        sql`select name,party_id as "partyId" from users where org_id=${c.orgId} and id=${c.actorId} for update`,
        "objects",
      )
    )[0];
    if (!user) throw new SampleCompanyError("The demonstration administrator is unavailable.");
    if (!user.partyId) {
      const personId = id("parties", "scenario-author");
      const person = await db.execute(
        sql`insert into parties(id,org_id,kind,display_name,created_by,updated_by) values(${personId},${c.orgId},'person',${user.name},${c.actorId},${c.actorId}) returning id`,
        "objects",
      );
      if (person.length !== 1)
        throw new SampleCompanyError("The demonstration author identity could not be created.");
      await db.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values(${c.orgId},'parties',${personId},'insert',${c.actorId},${JSON.stringify({ reason, after: { kind: "person", displayName: user.name } })}::jsonb)`,
      );
      const linked = await db.execute(
        sql`update users set party_id=${personId},updated_by=${c.actorId},updated_at=now() where org_id=${c.orgId} and id=${c.actorId} and party_id is null returning id`,
        "objects",
      );
      if (linked.length !== 1)
        throw new SampleCompanyError(
          "The demonstration author identity changed during preparation.",
        );
      await db.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values(${c.orgId},'users',${c.actorId},'update',${c.actorId},${JSON.stringify({ reason, before: { partyId: null }, after: { partyId: personId } })}::jsonb)`,
      );
    }
  }
  if (f.hrmTraining)
    for (const [index, name] of [
      "Patient privacy and records",
      "Safe clinical supplies handling",
      "Accessible patient communication",
    ].entries()) {
      const key = id("hrm_training_courses", `course-${index}`);
      if (
        (
          await db.execute(
            sql`select id from hrm_training_courses where org_id=${c.orgId} and id=${key}`,
            "objects",
          )
        ).length
      )
        continue;
      await createTrainingCourse({
        ...actor,
        id: key,
        subsidiaryId: c.subsidiaryId,
        code: `DEMO-COURSE-${index + 1}`,
        version: 1,
        name,
        description: "Synthetic internal course; this draft does not confer a clinical credential.",
        effectiveFrom: c.date,
        effectiveTo: null,
        qualificationTypeId: null,
        minimumAttendancePercent: 100,
        passingScore: 80,
        reason,
      });
    }
  if (f.hrmShiftPlanning) {
    // A staged shift roster board and an inactive weekday pattern for the
    // operator to review before assigning anyone.
    const roster = sampleRosterCopy(c.industryKey);
    const board = id("schedule_boards", "roster");
    if (
      !(
        await db.execute(
          sql`select id from schedule_boards where org_id=${c.orgId} and id=${board}`,
          "objects",
        )
      ).length
    ) {
      const inserted = await db.execute(
        sql`insert into schedule_boards (id, org_id, code, name, description, row_kind, board_type, subsidiary_id, grain, views, default_view,
        time_zone, publish_policy, created_by, updated_by)
        values (${board}, ${c.orgId}, ${roster.boardCode}, ${roster.boardName}, 'Synthetic shift roster; review staffing and attendance policy before publishing shifts.',
        'people', 'shift_roster', ${c.subsidiaryId}, 'timed', '{timeline,grid,calendar}', 'timeline', 'America/New_York', 'staged', ${c.actorId}, ${c.actorId}) returning id`,
        "objects",
      );
      if (inserted.length !== 1)
        throw new SampleCompanyError("The demonstration shift roster board could not be created.");
    }
    const key = id("schedule_patterns");
    if (
      !(
        await db.execute(
          sql`select id from schedule_patterns where org_id=${c.orgId} and id=${key}`,
          "objects",
        )
      ).length
    )
      await savePattern(actor, {
        id: key,
        subsidiaryId: c.subsidiaryId,
        code: roster.patternCode,
        name: roster.patternName,
        description:
          "Review staffing and attendance policy before activating and assigning the pattern.",
        timeZone: "America/New_York",
        cycleDays: 7,
        cycleAnchor: mondayOfIsoWeek(c.date),
        slots: [0, 1, 2, 3, 4].map((position) => ({
          position,
          starts: "08:00",
          ends: "16:30",
          breakMinutes: 30,
          qualificationTypeIds: [],
        })),
        target: null,
        projectTaskId: null,
        departmentId: null,
        detail: null,
        horizonDays: 28,
        isActive: false,
        reason,
      });
  }
  if (f.hrmAttendance) {
    const key = id("schedule_attendance_devices");
    if (
      !(
        await db.execute(
          sql`select id from schedule_attendance_devices where org_id=${c.orgId} and id=${key}`,
          "objects",
        )
      ).length
    ) {
      await saveAttendanceDevice(actor, {
        id: key,
        subsidiaryId: c.subsidiaryId,
        code: "DEMO-CLINIC-CLOCK",
        name: "Clinic attendance import — disconnected",
        timeZone: "America/New_York",
        isActive: false,
        reason,
      });
    }
  }
  if (f.compensationPackages)
    for (const [index, name] of [
      "Care team professional development",
      "Clinic travel allowance",
      "Practice performance award",
    ].entries()) {
      const key = id("payroll_compensation_packages", `package-${index}`);
      if (
        (
          await db.execute(
            sql`select id from payroll_compensation_packages where org_id=${c.orgId} and id=${key}`,
            "objects",
          )
        ).length
      )
        continue;
      await createCompensationPackage({
        ...actor,
        subsidiaryId: c.subsidiaryId,
        code: `DEMO-COMP-${index + 1}`,
        name,
        description:
          "Create and independently approve effective-dated terms before assigning to employees. This demonstration supplies no statutory rates.",
        country: "US",
        currency: c.currency,
        reason,
        idempotencyKey: key,
      });
    }
  if (f.inventory)
    for (const [index, name] of (INDUSTRY_STOCK[c.industryKey] ?? []).entries()) {
      const item = id("items", `operating-stock-${index + 1}`);
      if (
        (
          await db.execute(
            sql`select id from inventory_movements where org_id=${c.orgId} and item_id=${item} and kind='receipt' and status='posted'`,
            "objects",
          )
        ).length
      )
        continue;
      await receiveInventory(c.orgId, c.actorId, {
        itemId: item,
        stockLocationId: id("stock_locations"),
        quantity: "150.00",
        unitCost: ["12.50", "24.00", "38.00", "16.75"][index]!,
        subsidiaryId: c.subsidiaryId,
        offsetAccountId: c.accounts.payable,
        date: c.operationDate ?? c.date,
        idempotencyKey: `industry-demo:${c.orgId}:operating-stock-${index + 1}`,
        memo: `Synthetic opening supply — ${name}`,
        tx: db,
      });
    }
  if (f.consignment)
    for (const [index, quantity] of ["25.00", "40.00", "60.00"].entries()) {
      const description = `Synthetic supplier custody receipt ${index + 1}; ownership remains with the supplier`;
      if (
        (
          await db.execute(
            sql`select id from consignment_stock where org_id=${c.orgId} and stock_location_id=${id("stock_locations", "consignment")} and reason=${description}`,
            "objects",
          )
        ).length
      )
        continue;
      await moveConsignment(c.orgId, c.actorId, {
        action: "receive",
        itemId: id("items", "finished"),
        stockLocationId: id("stock_locations", "consignment"),
        subsidiaryId: c.subsidiaryId,
        quantity,
        date: c.operationDate ?? c.date,
        reason: description,
      });
    }
  if (f.crossBorderTax)
    for (
      let n = sampleOperatingPolicy(c.industryKey).postedCustomerInvoices + 1;
      n <= sampleOperatingPolicy(c.industryKey).postedCustomerInvoices + 3;
      n++
    ) {
      const documentId = id("documents", `operations-customer_invoice-${n}`);
      if (
        (
          await db.execute(
            sql`select 1 from document_supply_evidence where org_id=${c.orgId} and document_id=${documentId}`,
            "objects",
          )
        ).length
      )
        continue;
      await recordSupplyEvidence(
        db,
        c.orgId,
        documentId,
        {
          election: { supplyKind: "digital_service", customerKind: "business" },
          evidence: [
            {
              kind: "billing_address",
              country: "US",
              source: "Synthetic customer billing address",
            },
            {
              kind: "bank_country",
              country: "US",
              source: "Synthetic unverified remittance country",
            },
          ],
        },
        c.actorId,
      );
    }
  if (f.quoteToCash)
    for (let n = 1; n <= 3; n++) {
      const quote = (
        await db.execute<{ id: string; lineId: string }>(
          sql`select d.id,l.id as "lineId" from documents d join document_lines l on l.org_id=d.org_id and l.document_id=d.id and l.line_number=1 where d.org_id=${c.orgId} and d.external_source='industry_demo' and d.external_ref=${`operations-quote-${n}`}`,
          "objects",
        )
      )[0];
      if (!quote)
        throw new SampleCompanyError(
          "The subscription quote is missing; prepare native operating documents before configuring terms.",
        );
      if (
        (
          await db.execute(
            sql`select id from quote_subscription_terms where org_id=${c.orgId} and quote_id=${quote.id}`,
            "objects",
          )
        ).length
      )
        continue;
      await saveQuoteTerm(
        c.orgId,
        c.actorId,
        quote.id,
        {
          quoteLineId: quote.lineId,
          planId: id("subscription_plans", "operations-plan"),
          termMonths: 12,
          startRule: "first_of_next_month",
          billingTiming: "advance",
          steps: [{ startsAfterMonths: 0, unitPrice: "2400.00", quantity: "1.00" }],
        },
        null,
      );
    }
  if (f.fieldTickets)
    for (let n = 1; n <= 3; n++) {
      const fieldTicketId = id("documents", `operating-detail-${n}`);
      if (
        (
          await db.execute(
            sql`select id from field_ticket_labor_snapshots where org_id=${c.orgId} and field_ticket_id=${fieldTicketId}`,
            "objects",
          )
        ).length
      )
        continue;
      const lines = await db.execute<{
        employeePartyId: string;
        employeeName: string;
        itemId: string;
        itemName: string;
        timeTypeId: string;
        timeTypeName: string;
        projectTaskId: string;
        projectTaskName: string;
        workedOn: string;
        hours: string;
        timeEntryId: string;
        timeEntryStatus: string;
      }>(
        sql`select t.employee_party_id as "employeePartyId",p.display_name as "employeeName",t.item_id as "itemId",i.name as "itemName",
      t.time_type_id as "timeTypeId",tt.name as "timeTypeName",t.project_task_id as "projectTaskId",pt.name as "projectTaskName",
      t.worked_on::text as "workedOn",t.hours::text as hours,t.id as "timeEntryId",t.status as "timeEntryStatus"
      from time_entries t join parties p on p.org_id=t.org_id and p.id=t.employee_party_id
      join items i on i.org_id=t.org_id and i.id=t.item_id join time_types tt on tt.org_id=t.org_id and tt.id=t.time_type_id
      join project_tasks pt on pt.org_id=t.org_id and pt.id=t.project_task_id and pt.project_id=t.project_id
      where t.org_id=${c.orgId} and t.field_ticket_id=${fieldTicketId} order by t.id`,
        "objects",
      );
      if (lines.length !== 3)
        throw new SampleCompanyError(
          "The site ticket needs three native time rows linked to its own project and tasks before capturing labor evidence.",
        );
      await captureFieldTicketLaborEvidence({
        orgId: c.orgId,
        actorId: c.actorId,
        fieldTicketId,
        evidenceBasis: "operational_time",
        currency: c.currency,
        reason:
          "Capture synthetic draft site work for independent ticket review; labor and payroll remain unposted",
        lines: lines.map((line) => ({ ...line, timeClassification: "regular" as const })),
      });
    }
  if (f.projectProgress)
    for (let n = 1; n <= 3; n++) {
      const projectId = id("projects", `operations-project-${n}`);
      const taskId = id("project_tasks", `operations-project-${n}-task-2`);
      const note = `Synthetic installed quantity review ${n}`;
      const prior = await db.execute<{ id: string }>(
        sql`select id from project_progress_entries where org_id=${c.orgId} and project_id=${projectId} and project_task_id=${taskId} and note=${note}`,
        "objects",
      );
      if (prior.length > 1)
        throw new SampleCompanyError(
          "The authored progress identity is ambiguous; review its project history before refreshing.",
        );
      if (prior.length) continue;
      const scope = new Set([c.subsidiaryId]);
      const entry = await recordProgress({
        ...actor,
        projectId,
        taskId,
        entryDate: await businessTodayInTx(db, c.orgId),
        quantity: ["20.00", "35.00", "50.00"][n - 1]!,
        unit: "m2",
        note,
        allowedSubsidiaryIds: scope,
      });
      if (n === 3) {
        await reverseProgress({
          ...actor,
          projectId,
          entryId: entry.id,
          reason: "Correct the measured area after independent site review",
          allowedSubsidiaryIds: scope,
        });
        await recordProgress({
          ...actor,
          projectId,
          taskId,
          entryDate: await businessTodayInTx(db, c.orgId),
          quantity: "45.00",
          unit: "m2",
          note: "Corrected synthetic measured area",
          allowedSubsidiaryIds: scope,
        });
      }
    }
  if (f.informationReturns) {
    // The year's draft contractor filing for the legal entity; recipients are
    // computed only after the operator reviews TINs, box rules and thresholds.
    await ensureFiling({
      orgId: c.orgId,
      taxYear: c.year,
      formType: "1099-NEC",
      subsidiaryId: c.subsidiaryId,
      actorId: c.actorId,
    });
  }
  if (f.outboundWebhooks) {
    const key = id("webhook_endpoints");
    if (
      !(
        await db.execute(
          sql`select id from webhook_endpoints where org_id=${c.orgId} and id=${key}`,
          "objects",
        )
      ).length
    ) {
      const sealed = sealSecret(randomBytes(32).toString("hex"), {
        orgId: c.orgId,
        purpose: "webhook.endpoint.secret",
      });
      const inserted = await db.execute(
        sql`insert into webhook_endpoints(id,org_id,key,url,description,events,status,secret_sealed,disabled_reason,created_by,updated_by) values(${key},${c.orgId},'demo-integration','https://example.invalid/events','Disconnected synthetic event subscriber','{}'::text[],'disabled',${sealed},'Review URL and rotate signing secret before activation',${c.actorId},${c.actorId}) returning id`,
        "objects",
      );
      if (inserted.length !== 1)
        throw new SampleCompanyError("The disabled webhook example could not be recorded.");
      await db.execute(
        sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values(${c.orgId},'webhook_endpoints',${key},'insert',${c.actorId},${JSON.stringify({ reason, after: { key: "demo-integration", status: "disabled", events: [] } })}::jsonb)`,
      );
    }
  }
}
