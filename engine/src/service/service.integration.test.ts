import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  BUILT_IN_REPORT_DEFINITION_MAP,
  REPORT_ENTITY_MAP,
  runCustomQuery,
} from "@openbooks/reports";
import { db, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  grantScratchPermissions,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { installEngineSeams } from "../composition/install.ts";
import { receiveInventory } from "../inventory/movement-receive.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { controlDeps } from "../ledger/document-service.ts";
import { applyBoardChanges } from "../schedule-boards/entries.ts";
import {
  addAgreementVersion,
  createServiceAgreement,
  generateAgreementVisits,
} from "./agreements.ts";
import { invoiceServiceWork, serviceDepositCandidates } from "./billing.ts";
import { completeVisit, recordVisitPart } from "./completion.ts";
import { assignVisit, dispatchVisit, loadDispatchDay, moveVisitBooking } from "./dispatch.ts";
import { ServiceError } from "./errors.ts";
import { completeServiceJob, createServiceJob, reopenServiceJob } from "./jobs.ts";
import { getServiceVisit, listMyVisits, listServiceStockLocations } from "./reads.ts";
import {
  createPortalServiceRequest,
  createServiceRequest,
  listPortalServiceRequests,
} from "./requests.ts";
import { cancelVisit, setVisitFieldStatus } from "./visits.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { decideGate } from "../flows/gates.ts";
import { seedApprovalFlow } from "../testing/fixtures.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
installEngineSeams();

type Org = Awaited<ReturnType<typeof createScratchOrg>>;
type Fixture = {
  org: Org;
  today: string;
  dispatcher: string;
  dispatcher2: string;
  scheduler: string;
  techAUser: string;
  techBUser: string;
  techA: string;
  techB: string;
  dispatchBoard: string;
  rosterBoard: string;
  repairItem: string;
  laborItem: string;
  addressId: string;
  gasType: string;
};

const affected = (result: { rowCount: number | null }, label: string) => {
  if (result.rowCount !== 1) throw new Error(`${label} did not affect one row`);
};
const code = (expected: string) => (error: unknown) =>
  error instanceof ServiceError && error.code === expected;
const at = (date: string, time: string) => `${date}T${time}:00.000Z`;

async function technician(
  orgId: string,
  subsidiaryId: string,
  name: string,
  userId: string,
): Promise<{ party: string; employment: string }> {
  const party = randomUUID();
  affected(
    await db.execute<never>(
      sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${party}, ${orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`,
    ),
    "technician",
  );
  affected(
    await db.execute<never>(
      sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${orgId}, ${party}, 'Service technician', '2026-01-01', true)`,
    ),
    "employee role",
  );
  affected(
    await db.execute<never>(
      sql`update users set party_id = ${party} where org_id = ${orgId} and id = ${userId}`,
    ),
    "user link",
  );
  return { party, employment: await seedWorkerEmployment(orgId, party, subsidiaryId) };
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ids = await withBypassContext(async () => {
      const today = (
        await db.execute<{ today: string }>(
          sql`select (now() at time zone 'UTC')::date::text as today`,
          "objects",
        )
      )[0]!.today;
      // The scratch spine holds one fixed month; invoices and stock movements date today.
      const calendar = (
        await db.execute<{ fiscalCalendarId: string }>(
          sql`select fiscal_calendar_id as "fiscalCalendarId" from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}`,
          "objects",
        )
      )[0]!.fiscalCalendarId;
      const monthStart = `${today.slice(0, 7)}-01`;
      const exists = (
        await db.execute(
          sql`select 1 from accounting_periods where org_id = ${org.orgId} and starts_on <= ${today} and ends_on >= ${today}`,
          "objects",
        )
      ).length;
      if (!exists) {
        affected(
          await db.execute<never>(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, ${Number(today.slice(0, 4))}, ${Number(today.slice(5, 7))}, ${today.slice(0, 7)}, ${monthStart},
            (date_trunc('month', ${monthStart}::date) + interval '1 month - 1 day')::date, false, ${calendar})`),
          "current period",
        );
      }
      affected(
        await db.execute<never>(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"hrm":true,"hrmShiftPlanning":true,"serviceDispatch":true,"hrmCertifications":true,"timeTracking":true,"inventory":true,"orders":true}'::jsonb) where id = ${org.orgId}`),
        "features",
      );
      const dispatcher = await createScratchUser(org.orgId, "Dana Dispatcher", "service_office");
      const dispatcher2 = await createScratchUser(org.orgId, "Drew Dispatcher", "service_desk");
      const scheduler = await createScratchUser(org.orgId, "Sam Scheduler", "scheduler");
      const techAUser = await createScratchUser(org.orgId, "Alex Tech", "technician_a");
      const techBUser = await createScratchUser(org.orgId, "Blair Tech", "technician_b");
      await grantScratchPermissions(org.orgId, dispatcher, [
        "service.read",
        "service.manage",
        "service.dispatch",
        "ar.read",
        "ar.create",
        "ar.post",
        "items.read",
      ]);
      await grantScratchPermissions(org.orgId, dispatcher2, ["service.read", "service.dispatch"]);
      await grantScratchPermissions(org.orgId, scheduler, [
        "hrm.shifts.read",
        "hrm.shifts.manage",
        "hrm.shifts.approve",
      ]);
      await grantScratchPermissions(org.orgId, techAUser, ["service.self", "time.self"]);
      await grantScratchPermissions(org.orgId, techBUser, ["service.self", "time.self"]);
      const a = await technician(org.orgId, org.subsidiaryId, "Alex Tech", techAUser);
      const b = await technician(org.orgId, org.subsidiaryId, "Blair Tech", techBUser);
      const gasType = randomUUID();
      affected(
        await db.execute<never>(
          sql`insert into hrm_qualification_types (id, org_id, code, name, category) values (${gasType}, ${org.orgId}, 'GAS', 'Gas fitter', 'license')`,
        ),
        "qualification type",
      );
      affected(
        await db.execute<never>(sql`insert into hrm_worker_qualifications (org_id, employment_id, type_id, issued_on, status, verified_by, verified_at)
        values (${org.orgId}, ${a.employment}, ${gasType}, '2026-01-01', 'valid', ${dispatcher}, now())`),
        "Alex holds the gas ticket",
      );
      affected(
        await db.execute<never>(
          sql`insert into customer_roles (org_id, party_id, is_active) values (${org.orgId}, ${org.customerId}, true)`,
        ),
        "customer role",
      );
      const addressId = randomUUID();
      affected(
        await db.execute<never>(sql`insert into addresses (id, org_id, party_id, label, line1, city, region, postal_code, country)
        values (${addressId}, ${org.orgId}, ${org.customerId}, 'Plant', '12 Furnace Rd', 'Hamilton', 'ON', 'L8P 1A1', 'CA')`),
        "service address",
      );
      const item = async (name: string) => {
        const id = randomUUID();
        affected(
          await db.execute<never>(sql`insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
          values (${id}, ${org.orgId}, 'service', ${name}, false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})`),
          name,
        );
        return id;
      };
      const board = async (
        code: string,
        type: "dispatch" | "shift_roster",
        views: string,
        defaultView: string,
      ) => {
        const id = randomUUID();
        affected(
          await db.execute<never>(sql`insert into schedule_boards (id, org_id, code, name, row_kind, board_type, views, default_view, grain, time_zone, publish_policy, day_starts, day_ends, day_break_minutes)
          values (${id}, ${org.orgId}, ${code}, ${`Board ${code}`}, 'people', ${type}, ${views}::text[], ${defaultView}, 'timed', 'UTC', 'live', '07:00', '19:00', 0)`),
          "board",
        );
        return id;
      };
      affected(
        await db.execute<never>(sql`insert into service_dispatch_policies (org_id, effective_from, notify_arrival_window, notify_en_route, arrival_window_minutes,
          default_visit_minutes, urgent_response_hours, high_response_hours, normal_response_hours, low_response_hours, agreement_horizon_days, reason, created_by)
        values (${org.orgId}, '2020-01-01', false, false, 120, 60, 4, 24, 72, null, 28, 'Service desk standards', ${dispatcher})`),
        "dispatch policy",
      );
      return {
        today,
        dispatcher,
        dispatcher2,
        scheduler,
        techAUser,
        techBUser,
        techA: a.party,
        techB: b.party,
        gasType,
        addressId,
        dispatchBoard: await board("DISPATCH", "dispatch", "{dispatch,timeline}", "dispatch"),
        rosterBoard: await board("ROSTER", "shift_roster", "{timeline,grid}", "timeline"),
        repairItem: await item("Furnace repair"),
        laborItem: await item("Technician labour"),
      };
    });
    await run({ org, ...ids });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

const as = (f: Fixture, actorId: string) => ({ orgId: f.org.orgId, actorId });

async function newJob(
  f: Fixture,
  overrides: {
    requiredQualificationTypeIds?: string[];
    billingMode?: "per_job" | "per_visit";
  } = {},
) {
  return createServiceJob({
    ...as(f, f.dispatcher),
    id: randomUUID(),
    input: {
      customerPartyId: f.org.customerId,
      serviceAddressId: f.addressId,
      title: "No heat in plant office",
      priority: "high",
      estimatedMinutes: 60,
      billingMode: overrides.billingMode ?? "per_visit",
      laborItemId: f.laborItem,
      laborUnitPrice: "80",
      requiredQualificationTypeIds: overrides.requiredQualificationTypeIds ?? [],
      lines: [
        {
          itemId: f.repairItem,
          quantity: "1",
          unitPrice: "120.00",
          description: "Diagnose and repair furnace",
        },
      ],
      firstVisit: { preferredOn: f.today },
    },
  });
}

test(
  "a job is dispatched, worked, completed with a stock part and labor, and invoiced per visit into a balanced posting",
  enabled,
  async () =>
    fixture(async (f) => {
      const { job, visitId } = await newJob(f);
      assert.ok(visitId, "the job starts with an unscheduled visit");
      assert.ok(job.slaDueAt, "a high-priority job carries the policy's response target");
      const day = await loadDispatchDay({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        date: f.today,
      });
      assert.ok(
        day.queue.some((card) => card.visitId === visitId),
        "the visit waits in the unscheduled queue",
      );
      assert.ok(day.technicians.some((tech) => tech.partyId === f.techA));

      const assigned = await assignVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId: visitId!,
        expectedRevision: 1,
        workerPartyId: f.techA,
        startsAt: at(f.today, "14:00"),
      });
      assert.equal(assigned.visitStatus, "scheduled");
      assert.deepEqual(
        assigned.notices.map((notice) => notice.kind),
        ["arrival_window"],
        "booking a visit announces its arrival window",
      );
      const window = (
        await withBypassContext(() =>
          db.execute<{ startsAt: string; endsAt: string }>(
            sql`select to_char(window_starts_at at time zone 'UTC', 'HH24:MI') as "startsAt",
    to_char(window_ends_at at time zone 'UTC', 'HH24:MI') as "endsAt" from service_visits where id = ${visitId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(
        window,
        { startsAt: "14:00", endsAt: "16:00" },
        "the arrival window takes the policy's width from the booked start",
      );
      const dispatched = await dispatchVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId: visitId!,
        expectedRevision: assigned.visitRevision,
      });

      const tech = as(f, f.techAUser);
      const enRoute = await setVisitFieldStatus({
        ...tech,
        visitId: visitId!,
        expectedRevision: dispatched.visitRevision,
        to: "en_route",
      });
      assert.deepEqual(
        enRoute.notices.map((notice) => notice.kind),
        ["en_route"],
      );
      const onSite = await setVisitFieldStatus({
        ...tech,
        visitId: visitId!,
        expectedRevision: enRoute.revision,
        to: "on_site",
      });

      const otherSubsidiaryId = randomUUID();
      const otherLocationId = randomUUID();
      const otherStockLocationId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${otherSubsidiaryId}, ${f.org.orgId}, ${f.org.subsidiaryId}, 'Other service entity', 'CAD', 'CA')`);
        await db.execute(sql`insert into locations (id, org_id, name, subsidiary_id)
      values (${otherLocationId}, ${f.org.orgId}, 'Other service warehouse', ${otherSubsidiaryId})`);
        await db.execute(sql`insert into stock_locations (id, org_id, location_id, code, kind, inventory_ownership, is_active)
      values (${otherStockLocationId}, ${f.org.orgId}, ${otherLocationId}, 'OTHER', 'warehouse', 'owned', true)`);
      });
      const visibleLocations = await listServiceStockLocations(
        f.org.orgId,
        new Set([f.org.subsidiaryId]),
      );
      assert.ok(visibleLocations.some((location) => location.id === f.org.stockLocationId));
      assert.ok(
        !visibleLocations.some((location) => location.id === otherStockLocationId),
        "a scoped picker hides another subsidiary's warehouse",
      );
      const allLocations = await listServiceStockLocations(f.org.orgId, null);
      assert.ok(
        allLocations.some((location) => location.id === otherStockLocationId),
        "an unrestricted picker can see the warehouse",
      );
      await assert.rejects(
        recordVisitPart({
          ...tech,
          visitId: visitId!,
          expectedRevision: onSite.revision,
          part: {
            itemId: f.org.items.fifo,
            stockLocationId: otherStockLocationId,
            quantity: "1",
            unitPrice: "15.00",
            billable: false,
          },
        }),
        (error: unknown) => error instanceof ServiceError && error.code === "service_invalid",
      );

      await withBypassContext(() =>
        receiveInventory(f.org.orgId, f.dispatcher, {
          itemId: f.org.items.fifo,
          stockLocationId: f.org.stockLocationId,
          quantity: "10",
          unitCost: "5.00",
          subsidiaryId: f.org.subsidiaryId,
          offsetAccountId: f.org.accounts.clearing,
          date: f.today,
          idempotencyKey: `van-stock:${randomUUID()}`,
        }),
      );
      const part = await recordVisitPart({
        ...tech,
        visitId: visitId!,
        expectedRevision: onSite.revision,
        part: {
          itemId: f.org.items.fifo,
          stockLocationId: f.org.stockLocationId,
          quantity: "2",
          unitPrice: "15.00",
          billable: true,
        },
      });
      const completed = await completeVisit({
        ...tech,
        visitId: visitId!,
        expectedRevision: part.visitRevision,
        workNotes: "Replaced igniter and flame sensor; tested two cycles.",
        labor: [{ startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), hours: "1.5000" }],
      });
      assert.equal(completed.reviewStatus, "not_required", "no review Flow gates completion");
      assert.equal(completed.partsIssued, 1);
      assert.equal(completed.laborEntryIds.length, 1);

      const issued = (
        await withBypassContext(() =>
          db.execute<{ movementId: string | null }>(
            sql`select inventory_movement_id as "movementId" from service_visit_parts where id = ${part.partId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.ok(issued.movementId, "the part issued from stock at completion");
      const labor = await withBypassContext(() =>
        db.execute<{ status: string; hours: string; billable: boolean }>(
          sql`select status, hours::text, is_billable as billable from time_entries where service_visit_id = ${visitId}`,
          "objects",
        ),
      );
      assert.deepEqual(
        labor,
        [{ status: "draft", hours: "1.5000", billable: true }],
        "labor stays available for submission from the technician's timesheet",
      );
      const week = await withBypassContext(() =>
        db.execute<{ status: string }>(
          sql`
    select distinct w.status from timesheet_weeks w
    join time_entries te on te.org_id = w.org_id and te.employee_party_id = w.employee_party_id
      and te.worked_on between w.week_start and w.week_start + 6
    where te.service_visit_id = ${visitId}`,
          "objects",
        ),
      );
      assert.deepEqual(
        week,
        [{ status: "draft" }],
        "the week remains submittable through the timesheet workflow",
      );
      await assert.rejects(
        invoiceServiceWork({ ...as(f, f.dispatcher), jobId: job.id, visitId }),
        code("service_labor_unapproved"),
      );
      // Timesheet approval is the native approver's decision.
      await withBypassContext(() =>
        db.execute(
          sql`update time_entries set status = 'approved', approved_by = ${f.dispatcher}, approved_at = now() where service_visit_id = ${visitId}`,
        ),
      );

      const invoice = await invoiceServiceWork({ ...as(f, f.dispatcher), jobId: job.id, visitId });
      const lines = await withBypassContext(() =>
        db.execute<{ itemId: string | null; amount: string; quantity: string }>(
          sql`select item_id as "itemId", amount::text, quantity::text
    from document_lines where document_id = ${invoice.invoiceId} order by line_number`,
          "objects",
        ),
      );
      assert.deepEqual(
        lines.map((line) => line.amount),
        ["120.0000", "30.0000", "120.0000"],
        "scope, the billable part and 1.5 h of labor at 80",
      );
      assert.equal(
        lines[1]!.itemId,
        null,
        "an issued stock part bills on the item's income account so stock is not relieved twice",
      );
      assert.equal(lines[2]!.itemId, f.laborItem);
      const replay = await invoiceServiceWork({ ...as(f, f.dispatcher), jobId: job.id, visitId });
      assert.equal(
        replay.invoiceId,
        invoice.invoiceId,
        "a retried invoice command returns the same invoice",
      );
      assert.equal(replay.replayed, true);

      const entryId = await withBypassContext(async () => {
        assert.equal(
          (await submitAndReleaseIfUngated("customer_invoice", invoice.invoiceId, f.dispatcher))
            .autoApproved,
          true,
        );
        return postDocument(invoice.invoiceId, await controlDeps(f.org.orgId), {
          audit: { actorId: f.dispatcher, source: "api" },
        });
      });
      const totals = (
        await withBypassContext(() =>
          db.execute<{ debits: string; credits: string; receivable: string }>(
            sql`select
      sum(case when amount > 0 then amount else 0 end)::text as debits, sum(case when amount < 0 then -amount else 0 end)::text as credits,
      sum(case when account_id = ${f.org.accounts.ar} then amount else 0 end)::text as receivable
    from journal_lines where entry_id = ${entryId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(totals.debits, totals.credits, "the invoice posting balances");
      assert.equal(totals.receivable, "270.0000");
      const issues = (
        await withBypassContext(() =>
          db.execute<{ count: number }>(
            sql`select count(*)::int as count from inventory_movements
    where org_id = ${f.org.orgId} and item_id = ${f.org.items.fifo} and kind = 'issue'`,
            "objects",
          ),
        )
      )[0]!.count;
      assert.equal(issues, 1, "posting the invoice issued no further stock");
      const billed = await withBypassContext(() =>
        db.execute<{ billing: string }>(
          sql`select billing_status as billing from time_entries where service_visit_id = ${visitId}`,
          "objects",
        ),
      );
      assert.deepEqual(billed, [{ billing: "billed" }]);

      // The service reports run on the native report engine over the same records.
      await withOrgContext(f.org.orgId, async () => {
        const run = (slug: string) =>
          runCustomQuery(pool, BUILT_IN_REPORT_DEFINITION_MAP[slug]!.query, {
            orgId: f.org.orgId,
            entityMap: REPORT_ENTITY_MAP,
            asOf: f.today,
          });
        for (const slug of [
          "service-jobs-by-status",
          "service-first-time-fix",
          "service-quote-win-rate",
          "service-revenue-per-job",
        ])
          await run(slug);
        const utilization = await run("service-technician-utilization");
        assert.equal(utilization.rowCount, 1, "one technician worked one week");
        const group = utilization.groups[0]!;
        const row = Object.fromEntries(
          group.rows[0]!.map((cell, index) => [group.columns[index], cell]),
        );
        assert.equal(row["Technician"], "Alex Tech");
        assert.equal(Number(row["Booked hours"]), 1, "the one-hour booking counts as booked time");
        assert.equal(
          Number(row["Recorded hours"]),
          1.5,
          "the recorded labor counts as worked time",
        );
      });
    }),
);

test(
  "agreement generation is idempotent, keeps skipped occurrences and supersedes only unscheduled visits from a new version's date",
  enabled,
  async () =>
    fixture(async (f) => {
      const startsOn = addCalendarDays(f.today, 1);
      const created = await createServiceAgreement({
        ...as(f, f.dispatcher),
        id: randomUUID(),
        input: {
          customerPartyId: f.org.customerId,
          serviceAddressId: f.addressId,
          title: "Quarterly HVAC maintenance",
          startsOn,
          reason: "Signed maintenance plan",
          version: {
            recurrence: { repeat: "weekly", interval: 1 },
            windowStarts: "08:00",
            windowEnds: "12:00",
            estimatedMinutes: 90,
            priority: "normal",
            lines: [
              {
                itemId: f.repairItem,
                quantity: "1",
                unitPrice: "95.00",
                description: "Planned maintenance visit",
              },
            ],
          },
        },
      });
      assert.equal(
        created.generated,
        4,
        "a 28-day horizon from today holds four weekly occurrences",
      );
      const agreementId = created.agreement.id;
      assert.equal(
        (await generateAgreementVisits({ ...as(f, f.dispatcher), agreementId })).generated,
        0,
        "regeneration creates nothing new",
      );
      const visits = async () =>
        await withBypassContext(() =>
          db.execute<{
            id: string;
            occursOn: string;
            status: string;
            cancelKind: string | null;
            revision: number;
            versionId: string;
          }>(
            sql`
    select id, occurs_on::text as "occursOn", status, cancel_kind as "cancelKind", revision, agreement_version_id as "versionId"
    from service_visits where agreement_id = ${agreementId} order by occurs_on, created_at`,
            "objects",
          ),
        );
      const [first, second, third] = await visits();
      await cancelVisit({
        ...as(f, f.dispatcher),
        visitId: first!.id,
        expectedRevision: first!.revision,
        reason: "Customer closed that week",
        skip: true,
      });
      assert.equal(
        (await generateAgreementVisits({ ...as(f, f.dispatcher), agreementId })).generated,
        0,
        "a skipped occurrence is a decision regeneration keeps",
      );
      await assignVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId: third!.id,
        expectedRevision: third!.revision,
        workerPartyId: f.techA,
        startsAt: at(third!.occursOn, "08:00"),
        overrideReason: "Planned visit",
      });

      const effectiveFrom = second!.occursOn;
      const changed = await addAgreementVersion({
        ...as(f, f.dispatcher),
        agreementId,
        expectedRevision: (
          await withBypassContext(() =>
            db.execute<{ revision: number }>(
              sql`select revision from service_agreements where id = ${agreementId}`,
              "objects",
            ),
          )
        )[0]!.revision,
        effectiveFrom,
        reason: "Customer moved to fortnightly visits",
        version: {
          recurrence: { repeat: "weekly", interval: 2 },
          windowStarts: "13:00",
          windowEnds: "16:00",
          estimatedMinutes: 120,
          priority: "normal",
          lines: [{ itemId: f.repairItem, quantity: "1", unitPrice: "140.00" }],
        },
      });
      assert.equal(changed.kept, 1, "the booked visit keeps the terms it was promised under");
      const after = await visits();
      const live = after.filter((visit) => visit.status !== "cancelled");
      assert.ok(
        after.some((visit) => visit.cancelKind === "superseded"),
        "unscheduled occurrences from the new date are superseded",
      );
      assert.ok(
        live
          .filter((visit) => visit.occursOn >= effectiveFrom && visit.status === "unscheduled")
          .every((visit) => visit.versionId !== first!.versionId),
        "every unscheduled visit from the new date belongs to the new version",
      );
      assert.equal(
        after.find((visit) => visit.id === first!.id)?.cancelKind,
        "skipped",
        "the skip stands across versions",
      );
      assert.equal(
        (await generateAgreementVisits({ ...as(f, f.dispatcher), agreementId })).generated,
        0,
        "regeneration under the new version is idempotent too",
      );
    }),
);

test(
  "voiding a per-job invoice releases its billing link before reopening the job",
  enabled,
  async () =>
    fixture(async (f) => {
      const { job, visitId } = await newJob(f, { billingMode: "per_job" });
      assert.ok(visitId);
      const assigned = await assignVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId,
        expectedRevision: 1,
        workerPartyId: f.techA,
        startsAt: at(f.today, "14:00"),
      });
      const dispatched = await dispatchVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId,
        expectedRevision: assigned.visitRevision,
      });
      const enRoute = await setVisitFieldStatus({
        ...as(f, f.techAUser),
        visitId,
        expectedRevision: dispatched.visitRevision,
        to: "en_route",
      });
      const onSite = await setVisitFieldStatus({
        ...as(f, f.techAUser),
        visitId,
        expectedRevision: enRoute.revision,
        to: "on_site",
      });
      await completeVisit({
        ...as(f, f.techAUser),
        visitId,
        expectedRevision: onSite.revision,
        workNotes: "Completed the repair.",
      });
      const completedJob = await completeServiceJob({
        ...as(f, f.dispatcher),
        jobId: job.id,
        expectedRevision: job.revision,
      });
      const invoice = await invoiceServiceWork({ ...as(f, f.dispatcher), jobId: job.id });
      await withBypassContext(async () => {
        await submitAndReleaseIfUngated("customer_invoice", invoice.invoiceId, f.dispatcher);
        await postDocument(invoice.invoiceId, await controlDeps(f.org.orgId), {
          audit: { actorId: f.dispatcher, source: "api" },
        });
        const voided = await requestDocumentVoid({
          documentId: invoice.invoiceId,
          orgId: f.org.orgId,
          actorId: f.dispatcher,
          reason: "Correct the service invoice",
          reversalDate: f.today,
          source: "api",
        });
        assert.equal(voided.status, "voided");
      });

      const replacement = await invoiceServiceWork({ ...as(f, f.dispatcher), jobId: job.id });
      assert.notEqual(
        replacement.invoiceId,
        invoice.invoiceId,
        "retrying after a void creates a replacement invoice",
      );
      assert.equal(replacement.replayed, false);
      await withBypassContext(async () => {
        await submitAndReleaseIfUngated("customer_invoice", replacement.invoiceId, f.dispatcher);
        await postDocument(replacement.invoiceId, await controlDeps(f.org.orgId), {
          audit: { actorId: f.dispatcher, source: "api" },
        });
        const voided = await requestDocumentVoid({
          documentId: replacement.invoiceId,
          orgId: f.org.orgId,
          actorId: f.dispatcher,
          reason: "Correct the replacement service invoice",
          reversalDate: f.today,
          source: "api",
        });
        assert.equal(voided.status, "voided");
      });

      const reopened = await reopenServiceJob({
        ...as(f, f.dispatcher),
        jobId: job.id,
        expectedRevision: completedJob.revision,
        reason: "Correct the completed scope",
      });
      assert.equal(reopened.status, "open");
      const released = (
        await withBypassContext(() =>
          db.execute<{ releasedAt: string | null; reason: string | null }>(
            sql`
    select released_at as "releasedAt", release_reason as reason from service_billings
     where org_id = ${f.org.orgId} and job_id = ${job.id} and invoice_document_id = ${invoice.invoiceId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.ok(released.releasedAt);
      assert.equal(released.reason, "The invoice was voided");
      const releasedCount = (
        await withBypassContext(() =>
          db.execute<{ count: number }>(
            sql`select count(*)::int as count from service_billings
    where org_id = ${f.org.orgId} and job_id = ${job.id} and released_at is not null`,
            "objects",
          ),
        )
      )[0]!.count;
      assert.equal(releasedCount, 2, "both voided billing links are released");
    }),
);

test("rejecting a completion removes draft labor from a later invoice", enabled, async () =>
  fixture(async (f) => {
    const { job, visitId } = await newJob(f);
    assert.ok(visitId);
    await withBypassContext(() =>
      seedApprovalFlow(f.org.orgId, {
        subjectKind: "service_visit_completion",
        assignees: [{ type: "user", userId: f.dispatcher }],
        mode: "any",
      }),
    );
    const assigned = await assignVisit({
      ...as(f, f.dispatcher),
      boardId: f.dispatchBoard,
      visitId,
      expectedRevision: 1,
      workerPartyId: f.techA,
      startsAt: at(f.today, "14:00"),
    });
    const dispatched = await dispatchVisit({
      ...as(f, f.dispatcher),
      boardId: f.dispatchBoard,
      visitId,
      expectedRevision: assigned.visitRevision,
    });
    const enRoute = await setVisitFieldStatus({
      ...as(f, f.techAUser),
      visitId,
      expectedRevision: dispatched.visitRevision,
      to: "en_route",
    });
    const onSite = await setVisitFieldStatus({
      ...as(f, f.techAUser),
      visitId,
      expectedRevision: enRoute.revision,
      to: "on_site",
    });
    const first = await completeVisit({
      ...as(f, f.techAUser),
      visitId,
      expectedRevision: onSite.revision,
      workNotes: "First completion attempt.",
      labor: [{ startedAt: at(f.today, "08:00"), hours: "4" }],
    });
    assert.equal(first.reviewStatus, "pending");
    const firstGate = (
      await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`
    select id from flow_gates where org_id = ${f.org.orgId} and subject_kind = 'service_visit_completion' and subject_id = ${visitId} and status = 'pending'`,
          "objects",
        ),
      )
    )[0]!;
    await withOrgContext(f.org.orgId, () =>
      decideGate({
        gateId: firstGate.id,
        decision: "rejected",
        userId: f.dispatcher,
        comment: "Correct the work record",
      }),
    );
    const rejectedLabor = (
      await withBypassContext(() =>
        db.execute<{ status: string; rejectionReason: string | null }>(
          sql`
    select status, rejection_reason as "rejectionReason" from time_entries where org_id = ${f.org.orgId} and id = ${first.laborEntryIds[0]}`,
          "objects",
        ),
      )
    )[0]!;
    assert.deepEqual(rejectedLabor, {
      status: "rejected",
      rejectionReason: "Correct the work record",
    });

    const reopenedRevision = (
      await withBypassContext(() =>
        db.execute<{ revision: number }>(
          sql`
    select revision from service_visits where org_id = ${f.org.orgId} and id = ${visitId}`,
          "objects",
        ),
      )
    )[0]!.revision;
    const second = await completeVisit({
      ...as(f, f.techAUser),
      visitId,
      expectedRevision: reopenedRevision,
      workNotes: "Corrected completion.",
      labor: [{ startedAt: at(f.today, "08:00"), hours: "3" }],
    });
    assert.equal(second.reviewStatus, "pending");
    const secondGate = (
      await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`
    select id from flow_gates where org_id = ${f.org.orgId} and subject_kind = 'service_visit_completion' and subject_id = ${visitId} and status = 'pending'`,
          "objects",
        ),
      )
    )[0]!;
    await withOrgContext(f.org.orgId, () =>
      decideGate({ gateId: secondGate.id, decision: "approved", userId: f.dispatcher }),
    );
    await withBypassContext(() =>
      db.execute(sql`update time_entries set status = 'approved', approved_by = ${f.dispatcher}, approved_at = now()
    where org_id = ${f.org.orgId} and id = ${second.laborEntryIds[0]}`),
    );

    const invoice = await invoiceServiceWork({ ...as(f, f.dispatcher), jobId: job.id, visitId });
    const laborLine = (
      await withBypassContext(() =>
        db.execute<{ quantity: string; amount: string }>(
          sql`
    select quantity::numeric(20, 4)::text, amount::text from document_lines where org_id = ${f.org.orgId} and document_id = ${invoice.invoiceId} and item_id = ${f.laborItem}`,
          "objects",
        ),
      )
    )[0]!;
    assert.deepEqual(laborLine, { quantity: "3.0000", amount: "240.0000" });
  }),
);

test(
  "two dispatchers assigning the same visit: exactly one booking wins and the other is refused as stale",
  enabled,
  async () =>
    fixture(async (f) => {
      const { visitId } = await newJob(f);
      const results = await Promise.allSettled([
        assignVisit({
          ...as(f, f.dispatcher),
          boardId: f.dispatchBoard,
          visitId: visitId!,
          expectedRevision: 1,
          workerPartyId: f.techA,
          startsAt: at(f.today, "09:00"),
        }),
        assignVisit({
          ...as(f, f.dispatcher2),
          boardId: f.dispatchBoard,
          visitId: visitId!,
          expectedRevision: 1,
          workerPartyId: f.techB,
          startsAt: at(f.today, "10:00"),
        }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.ok(
        code("service_stale")(rejected.reason),
        `the loser is refused as stale: ${String(rejected.reason)}`,
      );
      const bookings = (
        await withBypassContext(() =>
          db.execute<{ count: number }>(
            sql`select count(*)::int as count from schedule_entries where service_visit_id = ${visitId} and status = 'published'`,
            "objects",
          ),
        )
      )[0]!.count;
      assert.equal(bookings, 1);
    }),
);

test("a technician sees and works only the visits booked on them", enabled, async () =>
  fixture(async (f) => {
    const { visitId } = await newJob(f);
    const assigned = await assignVisit({
      ...as(f, f.dispatcher),
      boardId: f.dispatchBoard,
      visitId: visitId!,
      expectedRevision: 1,
      workerPartyId: f.techA,
      startsAt: at(f.today, "11:00"),
    });
    const mine = await listMyVisits({ ...as(f, f.techAUser), from: f.today, through: f.today });
    assert.deepEqual(
      mine.visits.map((visit) => visit.id),
      [visitId],
    );
    assert.deepEqual(
      mine.visits[0]!.nextStatuses,
      ["en_route"],
      "the technician's next step is leaving for the visit",
    );
    assert.deepEqual(
      (await listMyVisits({ ...as(f, f.techBUser), from: f.today, through: f.today })).visits,
      [],
    );
    await assert.rejects(
      getServiceVisit({ ...as(f, f.techBUser), visitId: visitId! }),
      ScopeNotFoundError,
    );
    await assert.rejects(
      setVisitFieldStatus({
        ...as(f, f.techBUser),
        visitId: visitId!,
        expectedRevision: assigned.visitRevision,
        to: "en_route",
      }),
      ScopeNotFoundError,
    );
    const detail = await getServiceVisit({ ...as(f, f.techAUser), visitId: visitId! });
    assert.equal(detail.mode, "technician");
    assert.ok(
      detail.parts.every((p) => p.unitPrice === null),
      "technicians see no prices",
    );
    await assert.rejects(
      dispatchVisit({
        ...as(f, f.techAUser),
        boardId: f.dispatchBoard,
        visitId: visitId!,
        expectedRevision: assigned.visitRevision,
      }),
      (error: unknown) => error instanceof ScopeNotFoundError || error instanceof ServiceError,
      "dispatching is a dispatcher's duty",
    );
    await assert.rejects(
      loadDispatchDay({ ...as(f, f.techAUser), boardId: f.dispatchBoard, date: f.today }),
      "the dispatch board is staff-only",
    );
  }),
);

test(
  "one person is never double-booked across boards, and leave and qualifications block assignment",
  enabled,
  async () =>
    fixture(async (f) => {
      const shift = await applyBoardChanges({
        ...as(f, f.scheduler),
        boardId: f.rosterBoard,
        changes: [
          {
            op: "create",
            id: randomUUID(),
            workerPartyId: f.techA,
            onDate: f.today,
            target: null,
            span: { mode: "timed", starts: "13:00", ends: "17:00", breakMinutes: 0 },
          },
        ],
      });
      assert.equal(shift.results[0]!.ok, true, "Alex is on a roster shift in the afternoon");
      const { visitId } = await newJob(f);
      await assert.rejects(
        assignVisit({
          ...as(f, f.dispatcher),
          boardId: f.dispatchBoard,
          visitId: visitId!,
          expectedRevision: 1,
          workerPartyId: f.techA,
          startsAt: at(f.today, "15:00"),
          overrideReason: "Try anyway",
        }),
        (error: unknown) =>
          code("service_assignment_blocked")(error) &&
          Array.isArray((error as ServiceError).conflicts) &&
          ((error as ServiceError).conflicts as { code: string }[]).some(
            (conflict) => conflict.code === "overlap",
          ),
      );
      // Book the visit first, then try to roster the same hour: the booking ledger refuses it in storage.
      const morning = await assignVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId: visitId!,
        expectedRevision: 1,
        workerPartyId: f.techA,
        startsAt: at(f.today, "09:00"),
      });
      const clash = await applyBoardChanges({
        ...as(f, f.scheduler),
        boardId: f.rosterBoard,
        changes: [
          {
            op: "create",
            id: randomUUID(),
            workerPartyId: f.techA,
            onDate: f.today,
            target: null,
            span: { mode: "timed", starts: "08:30", ends: "10:00", breakMinutes: 0 },
          },
        ],
      });
      assert.equal(clash.results[0]!.ok, false);
      assert.equal(
        clash.results[0]!.ok === false && clash.results[0]!.code,
        "schedule_double_booked",
      );
      // A move keeps the visit's single booking, and the dispatch view refuses generic edits of it.
      const moved = await moveVisitBooking({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        entryId: morning.entryId!,
        expectedEntryRevision: 1,
        expectedVisitRevision: morning.visitRevision,
        workerPartyId: f.techA,
        startsAt: at(f.today, "10:00"),
      });
      const generic = await applyBoardChanges({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        changes: [{ op: "cancel", id: moved.entryId!, expectedRevision: 1 }],
      });
      assert.equal(
        generic.results[0]!.ok === false && generic.results[0]!.code,
        "schedule_visit_booking",
      );

      const gasJob = await newJob(f, { requiredQualificationTypeIds: [f.gasType] });
      await assert.rejects(
        assignVisit({
          ...as(f, f.dispatcher),
          boardId: f.dispatchBoard,
          visitId: gasJob.visitId!,
          expectedRevision: 1,
          workerPartyId: f.techB,
          startsAt: at(f.today, "09:00"),
        }),
        (error: unknown) =>
          code("service_assignment_blocked")(error) && /Gas fitter/.test((error as Error).message),
        "Blair holds no gas ticket",
      );
      const gas = await assignVisit({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        visitId: gasJob.visitId!,
        expectedRevision: 1,
        workerPartyId: f.techA,
        startsAt: at(f.today, "11:30"),
      });
      assert.equal(gas.visitStatus, "scheduled", "Alex holds the gas ticket");

      await assert.rejects(
        assignVisit({
          ...as(f, f.dispatcher),
          boardId: f.dispatchBoard,
          visitId: (await newJob(f)).visitId!,
          expectedRevision: 1,
          workerPartyId: f.techB,
          startsAt: at(f.today, "18:30"),
        }),
        code("service_assignment_needs_override"),
        "a visit outside working hours needs an override reason",
      );
    }),
);

test(
  "a portal request lands in the queue once, the customer sees only their own requests, and the board draws its working day",
  enabled,
  async () =>
    fixture(async (f) => {
      const portalLink = randomUUID();
      await withBypassContext(async () => {
        affected(
          await db.execute<never>(sql`insert into customer_portal_links (id, org_id, party_id, contact_email, purpose, token_hash, expires_at)
      values (${portalLink}, ${f.org.orgId}, ${f.org.customerId}, 'buyer@example.com', 'session', ${`hash-${portalLink}`}, now() + interval '1 hour')`),
          "portal session",
        );
      });
      const key = randomUUID();
      const asked = {
        orgId: f.org.orgId,
        partyId: f.org.customerId,
        linkId: portalLink,
        id: key,
        request: {
          title: "Thermostat keeps resetting",
          serviceAddressId: f.addressId,
          urgent: true,
        },
      };
      const first = await createPortalServiceRequest(asked);
      assert.equal(first.source, "portal");
      assert.equal(first.priority, "high", "an urgent portal request is taken at high priority");
      assert.equal(
        (await createPortalServiceRequest(asked)).id,
        first.id,
        "a resubmitted form returns the same request",
      );
      await assert.rejects(
        createPortalServiceRequest({
          ...asked,
          request: { ...asked.request, title: "Something else" },
        }),
        code("service_key_reused"),
      );
      await createServiceRequest({
        ...as(f, f.dispatcher),
        id: randomUUID(),
        input: {
          customerPartyId: f.org.customerId,
          title: "Annual inspection",
          priority: "normal",
        },
      });
      const listed = await listPortalServiceRequests(f.org.orgId, f.org.customerId);
      assert.deepEqual(listed.map((request) => request.title).sort(), [
        "Annual inspection",
        "Thermostat keeps resetting",
      ]);
      assert.deepEqual(
        await listPortalServiceRequests(f.org.orgId, f.techA),
        [],
        "another party sees none of the customer's requests",
      );

      const day = await loadDispatchDay({
        ...as(f, f.dispatcher),
        boardId: f.dispatchBoard,
        date: f.today,
      });
      assert.deepEqual(day.displayWindow, day.workingWindow, "the board draws its own working day");
      assert.equal(day.displayWindow.startsAt, at(f.today, "07:00"));

      const { job } = await newJob(f);
      assert.deepEqual(
        await serviceDepositCandidates({ ...as(f, f.dispatcher), jobId: job.id }),
        [],
        "no payment is held on account yet",
      );
      await assert.rejects(
        serviceDepositCandidates({ ...as(f, f.dispatcher2), jobId: job.id }),
        "listing deposits needs service management",
      );
    }),
);
