import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  assessLeaseLateFees,
  billDueLeaseCharges,
  runDuePropertyBilling,
  scheduleLeaseCharges,
} from "./property-management.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface PropertyFixture {
  org: ScratchOrg;
  /**
   * A real historical user who authored lease A: the trap the scheduler must
   * stop impersonating. Their id legitimately stays on the lease row itself.
   */
  historicalAuthorId: string;
  propertyId: string;
  leases: {
    authoredLeaseId: string;
    unauthoredLeaseId: string;
  };
}

async function seedPropertyFixture(): Promise<PropertyFixture> {
  const org = await createScratchOrg();
  const historicalAuthorId = await createScratchUser(org.orgId, "Historical lease author", "admin");
  // The scratch spine opens only July 2026; rent posting spans April→October.
  const calendarId = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id::text as id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]!.id;
  for (const month of [4, 5, 6, 8, 9, 10]) {
    const startsOn = `2026-${String(month).padStart(2, "0")}-01`;
    const endsOn = new Date(Date.UTC(month === 12 ? 2027 : 2026, month === 12 ? 0 : month, 1) - 86_400_000)
      .toISOString().slice(0, 10);
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${month},
              ${startsOn.slice(0, 7)}, ${startsOn}, ${endsOn}, false, ${calendarId})`);
  }
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${org.orgId}`);
  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, location_id, code, name, property_type, currency, rent_income_account_id)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-1',
            'Provenance Tower', 'commercial', 'CAD', ${org.accounts.revenue})`);
  const mkLease = async (leaseNumber: string, createdBy: string | null): Promise<string> => {
    const leaseId = randomUUID();
    await db.execute(sql`
      insert into property_leases
        (id, org_id, property_id, tenant_id, lease_number, status, starts_on, billing_day,
         payment_terms_days, late_fee_type, late_fee_value, grace_days, auto_invoice, auto_post,
         created_by, updated_by)
      values (${leaseId}, ${org.orgId}, ${propertyId}, ${org.customerId}, ${leaseNumber}, 'active', '2026-04-01',
              1, 0, 'fixed', '25', 0, true, true, ${createdBy}, ${createdBy})`);
    await db.execute(sql`
      insert into lease_charges
        (id, org_id, lease_id, charge_type, description, amount, frequency, effective_from, income_account_id)
      values (${randomUUID()}, ${org.orgId}, ${leaseId}, 'base_rent', 'Base rent', '1000.0000', 'monthly',
              '2026-04-01', ${org.accounts.revenue})`);
    return leaseId;
  };
  // One lease authored by a real user and one with NO author at all: both are
  // engine-initiated billing targets and must land with system provenance.
  const authoredLeaseId = await mkLease("L-2026-A", historicalAuthorId);
  const unauthoredLeaseId = await mkLease("L-2026-B", null);
  return { org, historicalAuthorId, propertyId, leases: { authoredLeaseId, unauthoredLeaseId } };
}

const rentInvoiceIds = (orgId: string) => db.execute<{ id: string }>(sql`
  select d.id::text as id from documents d
   where d.org_id = ${orgId} and d.kind = 'customer_invoice'
     and d.custom->'propertyManagement'->>'kind' = 'rent'
   order by d.id`);

const lateFeeCount = (orgId: string) =>
  db.execute<{ n: number }>(sql`
    select count(*)::int as n from lease_charges
     where org_id = ${orgId} and charge_type = 'late_fee'`)
    .then((r) => Number(r.rows[0]!.n));

test(
  "scheduled property billing carries system provenance per surface — never a historical or cross-lease actor",
  { skip: !DB },
  async () => {
    const fx = await seedPropertyFixture();
    try {
      const orgId = fx.org.orgId;
      const { authoredLeaseId, unauthoredLeaseId } = fx.leases;

      // ---- Tick one: schedules + rent invoices + auto-posting for April/May --
      const run0 = await runDuePropertyBilling("2026-05-15");
      assert.equal(run0.lateFees, 0, "nothing is overdue on the first tick");

      for (const [label, leaseId] of [
        ["authored", authoredLeaseId],
        ["unauthored", unauthoredLeaseId],
      ] as const) {
        // Surface 1: scheduled schedule generation persists explicit NULL actors.
        const schedules = (await db.execute<{ total: number; foreign: number }>(sql`
          select count(*)::int as total,
                 count(*) filter (where coalesce(created_by, updated_by) is not null)::int as foreign
            from lease_schedule_lines
           where org_id = ${orgId} and lease_id = ${leaseId}`)).rows[0]!;
        assert.ok(schedules.total > 0, `${label}: schedule lines are generated`);
        assert.equal(schedules.foreign, 0, `${label}: every schedule line carries system provenance`);

        // Surface 2: durable per-run/per-lease marker naming the scheduler run.
        const marker = (await db.execute<{
          actor: string | null; requestId: string | null; source: string | null; actorKind: string | null;
        }>(sql`
          select actor_id::text as actor, request_id as "requestId",
                 changes->>'source' as source, changes->>'actorKind' as "actorKind"
            from audit_log
           where org_id = ${orgId} and table_name = 'property_leases'
             and row_id = ${leaseId} and action = 'schedule_generated'`)).rows;
        assert.equal(marker.length, 1);
        assert.equal(marker[0]!.actor, null);
        assert.equal(marker[0]!.requestId, `property-billing:schedule:${leaseId}`);
        assert.equal(marker[0]!.source, "scheduler");
        assert.equal(marker[0]!.actorKind, "system");

        // Surface 3: rent invoice header, lines, auto-post evidence.
        const invoice = (await db.execute<{
          id: string; status: string; docActor: string | null;
          kind: string | null; leaseId: string | null; billingKey: string | null;
          runSource: string | null; actorKind: string | null;
          postActor: string | null; postSource: string | null; postRequest: string | null;
        }>(sql`
          select d.id::text as id, d.status,
                 d.created_by::text as "docActor",
                 d.custom->'propertyManagement'->>'kind' as kind,
                 d.custom->'propertyManagement'->>'leaseId' as "leaseId",
                 d.custom->'propertyManagement'->>'billingKey' as "billingKey",
                 d.custom->'propertyManagement'->>'billingRunSource' as "runSource",
                 d.custom->'propertyManagement'->>'actorKind' as "actorKind",
                 ta.actor_id::text as "postActor",
                 ta.changes->>'source' as "postSource",
                 ta.request_id as "postRequest"
            from documents d
            left join audit_log ta on ta.org_id = d.org_id and ta.table_name = 'documents'
              and ta.row_id = d.id and ta.action = 'post'
           where d.org_id = ${orgId}
             and d.kind = 'customer_invoice'
             and d.custom->'propertyManagement'->>'leaseId' = ${leaseId}`)).rows;
        assert.equal(invoice.length, 1);
        const inv = invoice[0]!;
        assert.equal(inv.status, "posted", `${label}: auto-posted rent invoice`);
        assert.equal(inv.docActor, null, `${label}: scheduler never impersonates a person`);
        assert.equal(inv.kind, "rent");
        assert.equal(inv.leaseId, leaseId);
        assert.equal(inv.runSource, "scheduler");
        assert.equal(inv.actorKind, "system");
        assert.match(inv.billingKey ?? "", new RegExp(`^rent:${leaseId}:`));
        assert.equal(inv.postSource, "property_rent_billing");
        assert.equal(inv.postRequest, "property_rent_billing");
        assert.equal(inv.postActor, null);

        const lineActors = (await db.execute<{ total: number; foreign: number }>(sql`
          select count(*)::int as total,
                 count(*) filter (where dl.created_by is not null)::int as foreign
            from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
           where d.custom->'propertyManagement'->>'leaseId' = ${leaseId}`)).rows[0]!;
        assert.ok(lineActors.total > 0, `${label}: invoice lines exist`);
        assert.equal(lineActors.foreign, 0, `${label}: every invoice line carries system provenance`);
      }

      // No cross-lease attribution: no rent invoice cites another lease's schedule lines.
      const crossLeased = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents d
         where d.org_id = ${orgId}
           and d.custom->'propertyManagement'->>'kind' = 'rent'
           and exists (
             select 1 from jsonb_array_elements_text(d.custom->'propertyManagement'->'scheduleIds') sid
               join lease_schedule_lines s on s.id::text = sid and s.org_id = d.org_id
              where s.lease_id <> (d.custom->'propertyManagement'->>'leaseId')::uuid)`)).rows[0]!.n;
      assert.equal(crossLeased, 0, "rent invoices never cite a sibling lease's schedule lines");

      // ---- Tick two: late fees assessed under system provenance --------------
      const run1 = await runDuePropertyBilling("2026-07-15");
      // The tick assesses before it bills, so exactly the April/May group per
      // lease was overdue: one fee per lease, each tied to its own source line.
      assert.equal(run1.invoices, 2, "one rent invoice per lease for June/July");

      for (const leaseId of [authoredLeaseId, unauthoredLeaseId]) {
        const fees = (await db.execute<{
          amount: string; effectiveOn: string; chargeActor: string | null; feeLineActor: string | null;
          sourceLease: string; sourceSchedule: string;
          auditActor: string | null; auditRequest: string | null; source: string | null;
        }>(sql`
          select c.amount::text as amount, c.effective_from::text as "effectiveOn",
                 c.created_by::text as "chargeActor",
                 s.created_by::text as "feeLineActor",
                 src.lease_id::text as "sourceLease",
                 s.source_schedule_id::text as "sourceSchedule",
                 al.actor_id::text as "auditActor",
                 al.request_id as "auditRequest",
                 al.changes->>'source' as source
            from lease_charges c
            join lease_schedule_lines s on s.charge_id = c.id and s.org_id = c.org_id
            join lease_schedule_lines src on src.id = s.source_schedule_id and src.org_id = s.org_id
            left join audit_log al on al.org_id = c.org_id and al.table_name = 'lease_schedule_lines'
              and al.row_id = s.id and al.action = 'late_fee_assess'
           where c.org_id = ${orgId} and c.charge_type = 'late_fee' and c.lease_id = ${leaseId}`)).rows;
        assert.equal(fees.length, 1);
        const fee = fees[0]!;
        assert.equal(fee.effectiveOn, "2026-07-15");
        assert.equal(fee.amount, "25.0000");
        assert.equal(fee.chargeActor, null);
        assert.equal(fee.feeLineActor, null);
        assert.equal(fee.sourceLease, leaseId, "per-lease attribution, not an org-wide first actor");
        assert.equal(fee.auditActor, null);
        assert.equal(fee.auditRequest, `property-billing:late_fee:${leaseId}:${fee.sourceSchedule}`);
        assert.equal(fee.source, "scheduler");
      }

      // ---- Idempotency replay: identical day produces nothing new ------------
      const invoicesBefore = (await rentInvoiceIds(orgId)).rows.map((r) => r.id).sort();
      const feesBefore = await lateFeeCount(orgId);
      const run2 = await runDuePropertyBilling("2026-07-15");
      assert.equal(run2.lateFees, 0);
      assert.deepEqual((await rentInvoiceIds(orgId)).rows.map((r) => r.id).sort(), invoicesBefore);
      assert.equal(await lateFeeCount(orgId), feesBefore);

      // ---- Interactive scheduling attributes the real operator ---------------
      const operatorId = await createScratchUser(orgId, "Operator", "admin");
      const priorB = new Set(
        (await db.execute<{ id: string }>(sql`
          select id::text as id from lease_schedule_lines
           where org_id = ${orgId} and lease_id = ${unauthoredLeaseId}`)).rows.map((r) => r.id),
      );
      const manual = await scheduleLeaseCharges(orgId, operatorId, unauthoredLeaseId, "2028-12-31");
      assert.ok(manual.created > 0, "interactive scheduling extends beyond the scheduler horizon");
      const freshB = (await db.execute<{ id: string; createdBy: string | null; updatedBy: string | null }>(sql`
        select id::text as id, created_by::text as "createdBy", updated_by::text as "updatedBy"
          from lease_schedule_lines
         where org_id = ${orgId} and lease_id = ${unauthoredLeaseId}`)).rows.filter((r) => !priorB.has(r.id));
      assert.equal(freshB.length, manual.created);
      for (const row of freshB) {
        assert.equal(row.createdBy, operatorId);
        assert.equal(row.updatedBy, operatorId);
      }
      const interactiveMarker = (await db.execute<{
        actor: string | null; requestId: string | null; source: string | null; actorKind: string | null;
      }>(sql`
        select actor_id::text as actor, request_id as "requestId",
               changes->>'source' as source, changes->>'actorKind' as "actorKind"
          from audit_log
         where org_id = ${orgId} and table_name = 'property_leases'
           and row_id = ${unauthoredLeaseId} and action = 'schedule_generated'
           and changes->>'source' = 'user'`)).rows;
      assert.equal(interactiveMarker.length, 1);
      assert.equal(interactiveMarker[0]!.actor, operatorId);
      assert.equal(interactiveMarker[0]!.requestId, null);
      assert.equal(interactiveMarker[0]!.actorKind, null);

      // The deepest engine boundary bills a null-author lease with a NULL actor:
      // no fallback to lease authorship and no throw.
      const sysBill = await billDueLeaseCharges(orgId, null, "2026-09-30", unauthoredLeaseId);
      assert.ok(sysBill.invoices.length >= 1, "null-author lease bills under a null actor");
      const sysDoc = (await db.execute<{ docActor: string | null; runSource: string | null }>(sql`
        select d.created_by::text as "docActor",
               d.custom->'propertyManagement'->>'billingRunSource' as "runSource"
          from documents d where d.id = ${sysBill.invoices.at(-1)!} and d.org_id = ${orgId}`)).rows[0]!;
      assert.equal(sysDoc.docActor, null);
      assert.equal(sysDoc.runSource, "scheduler");

      // Interactive billing attributes documents, lines, claimed schedule rows,
      // and posting evidence to gate.user.id.
      const userBill = await billDueLeaseCharges(orgId, operatorId, "2026-10-31", unauthoredLeaseId);
      assert.ok(userBill.invoices.length >= 1);
      const userDocId = userBill.invoices.at(-1)!;
      const userDoc = (await db.execute<{
        docActor: string | null; runSource: string | null; actorKind: string | null;
        postActor: string | null; postSource: string | null; foreignLines: number; staleScheduleRows: number;
      }>(sql`
        select d.created_by::text as "docActor",
               d.custom->'propertyManagement'->>'billingRunSource' as "runSource",
               d.custom->'propertyManagement'->>'actorKind' as "actorKind",
               ta.actor_id::text as "postActor",
               ta.changes->>'source' as "postSource",
               (select count(*)::int from document_lines dl
                 join documents x on x.id = dl.document_id and x.org_id = dl.org_id
                where x.custom->'propertyManagement'->>'billingRunSource' = 'user'
                  and dl.created_by <> ${operatorId}) as "foreignLines",
               (select count(*)::int from jsonb_array_elements_text(d.custom->'propertyManagement'->'scheduleIds') sid
                  join lease_schedule_lines s on s.id::text = sid and s.org_id = d.org_id
                 where s.updated_by <> ${operatorId}) as "staleScheduleRows"
          from documents d
          left join audit_log ta on ta.org_id = d.org_id and ta.table_name = 'documents'
            and ta.row_id = d.id and ta.action = 'post'
         where d.id = ${userDocId} and d.org_id = ${orgId}`)).rows[0]!;
      assert.equal(userDoc.docActor, operatorId);
      assert.equal(userDoc.runSource, "user");
      assert.equal(userDoc.actorKind, null);
      assert.equal(userDoc.postActor, operatorId);
      assert.equal(userDoc.postSource, "property_rent_billing");
      assert.equal(userDoc.foreignLines, 0);
      assert.equal(userDoc.staleScheduleRows, 0);

      // Interactive late fees carry the calling user and stay per-lease.
      const assessed = await assessLeaseLateFees(orgId, operatorId, "2027-06-30");
      assert.ok(assessed.created > 0, "interactive assessment creates overdue fees");
      const interactiveFees = (await db.execute<{
        total: number; foreignActor: number; foreignAuthor: number; detached: number;
      }>(sql`
        select count(*)::int as total,
               count(*) filter (where coalesce(c.created_by, c.updated_by, s.created_by, s.updated_by) <> ${operatorId})::int as "foreignActor",
               count(*) filter (where ${fx.historicalAuthorId} in (c.created_by::text, s.created_by::text))::int as "foreignAuthor",
               count(*) filter (where not exists (
                 select 1 from lease_schedule_lines src
                  where src.id = s.source_schedule_id and src.org_id = s.org_id
                    and src.lease_id = c.lease_id))::int as detached
          from lease_charges c
          join lease_schedule_lines s on s.charge_id = c.id and s.org_id = c.org_id
         where c.org_id = ${orgId} and c.charge_type = 'late_fee'
           and c.effective_from = date '2027-06-30'`)).rows[0]!;
      assert.equal(interactiveFees.total, assessed.created);
      assert.equal(interactiveFees.foreignActor, 0, "every fee names the calling user");
      assert.equal(interactiveFees.foreignAuthor, 0, "no fee impersonates the historical author");
      assert.equal(interactiveFees.detached, 0, "each fee still links to its own lease's source line");

      // Org-wide negative scan: the historical author never becomes an actor on
      // any generated artifact.
      const impersonated = (await db.execute<{ n: number }>(sql`
        select (
          (select count(*)::int from documents where org_id = ${orgId} and created_by = ${fx.historicalAuthorId}) +
          (select count(*)::int from document_lines
             join documents d on d.id = document_lines.document_id and d.org_id = document_lines.org_id
           where d.org_id = ${orgId} and document_lines.created_by = ${fx.historicalAuthorId}) +
          (select count(*)::int from lease_charges where org_id = ${orgId} and created_by = ${fx.historicalAuthorId}) +
          (select count(*)::int from lease_schedule_lines where org_id = ${orgId} and created_by = ${fx.historicalAuthorId})
        )::int as n`)).rows[0]!.n;
      assert.equal(impersonated, 0, "nothing in this org ever credits the historical author again");
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);
