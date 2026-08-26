import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import { db, pool } from "./db.ts";
import {
  addLeaseCharge,
  addLeaseEscalation,
  applyLeaseEscalation,
  assessLeaseLateFees,
  billDueLeaseCharges,
  createPropertyLease,
  runDuePropertyBilling,
  scheduleLeaseCharges,
  updatePropertyLease,
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

interface Statement {
  text: string;
  params?: unknown[];
}

type StatementResult = PromiseSettledResult<QueryResult>;

async function openSession(): Promise<{ client: PoolClient; pid: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const backend = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

const settle = (promise: Promise<QueryResult>): Promise<StatementResult> =>
  promise.then(
    (value): StatementResult => ({ status: "fulfilled", value }),
    (reason): StatementResult => ({ status: "rejected", reason }),
  );

/**
 * The second writer must WAIT on the storage guard while the first
 * transaction is open, then be rejected once it commits (0051's race shape).
 * Both sessions always roll back or commit nothing at the end.
 */
async function raceConflict(
  first: Statement,
  second: Statement,
): Promise<{ blocked: boolean; second: StatementResult }> {
  const sessionA = await openSession();
  const sessionB = await openSession();
  let openA = true;
  let openB = true;
  try {
    await sessionA.client.query(first.text, first.params ?? []);
    let settled: StatementResult | undefined;
    const secondPromise = settle(sessionB.client.query(second.text, second.params ?? []));
    void secondPromise.then((value) => {
      settled = value;
    });
    let blocked = false;
    for (let attempt = 0; attempt < 500 && settled === undefined && !blocked; attempt += 1) {
      const state = await pool.query<{ blocked: boolean }>(
        "select $1::int = any(pg_blocking_pids($2::int)) as blocked",
        [sessionA.pid, sessionB.pid],
      );
      if (state.rows[0]?.blocked) blocked = true;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!blocked && settled === undefined) {
      throw new Error(`conflict race never reached a decision (blocker ${sessionA.pid}, waiter ${sessionB.pid})`);
    }
    await sessionA.client.query("commit");
    openA = false;
    const result = settled ?? (await secondPromise);
    await sessionB.client.query("rollback").catch(() => undefined);
    openB = false;
    return { blocked, second: result };
  } finally {
    if (openA) await sessionA.client.query("rollback").catch(() => undefined);
    if (openB) await sessionB.client.query("rollback").catch(() => undefined);
    sessionA.client.release();
    sessionB.client.release();
  }
}

/** Drizzle wraps driver errors, so the PostgreSQL message lives on `cause`. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause;
  return String(cause?.message ?? error);
}

const baseRentInsertFor = (orgId: string, leaseId: string, from: string) => ({
  text: `insert into lease_charges (org_id, lease_id, charge_type, description, amount, frequency, effective_from)
         values ($1, $2, 'base_rent', 'Base rent', '1000.0000', 'monthly', $3)`,
  params: [orgId, leaseId, from] as unknown[],
});

test(
  "overlapping base-rent intervals are rejected at storage — even raced — while adjacent escalation windows commit",
  { skip: !DB },
  async () => {
    const fx = await seedPropertyFixture();
    try {
      const orgId = fx.org.orgId;
      const leaseId = fx.leases.authoredLeaseId;

      // Direct SQL (the path that bypasses every service precheck) cannot add
      // a second overlapping base_rent beside the canonical row.
      const rejected = await db.execute(sql`
        insert into lease_charges (org_id, lease_id, charge_type, description, amount, frequency, effective_from)
        values (${orgId}, ${leaseId}, 'base_rent', 'Second rent', '1000.0000', 'monthly', '2026-05-01')`)
        .then(() => null, (error: unknown) => error);
      assert.match(pgMessage(rejected), /lease_charges_base_rent_no_overlap/, "storage refuses a mid-window duplicate");

      // Two concurrent writers both racing an overlapping base_rent onto one
      // lease: exactly one commits, the other waits on and loses to the index.
      const orphanLease = randomUUID();
      await db.execute(sql`
        insert into property_leases (id, org_id, property_id, tenant_id, lease_number, status, starts_on, billing_day,
          payment_terms_days, late_fee_type, late_fee_value, grace_days, auto_invoice, auto_post)
        values (${orphanLease}, ${orgId}, ${fx.propertyId}, ${fx.org.customerId}, 'L-RACE', 'active', '2026-04-01',
                1, 0, 'none', '0', 0, false, false)`);
      const raced = await raceConflict(
        baseRentInsertFor(orgId, orphanLease, "2026-01-01"),
        baseRentInsertFor(orgId, orphanLease, "2026-03-15"),
      );
      assert.equal(raced.blocked, true, "the conflicting write must wait on the storage guard");
      assert.equal(raced.second.status, "rejected", "the losing writer must be rejected once the blocker commits");
      assert.match(
        String((raced.second.status === "rejected" ? raced.second.reason : null)),
        /exclusion constraint/,
      );
      await db.execute(sql`delete from lease_charges where lease_id = ${orphanLease} and org_id = ${orgId}`);
      await db.execute(sql`delete from property_leases where id = ${orphanLease} and org_id = ${orgId}`);

      // A controlled escalation's supersede convention stays representable:
      // close the old window at day X-1 and insert its successor at X.
      const predecessor = (await db.execute<{ id: string }>(sql`
        select id from lease_charges
         where org_id = ${orgId} and lease_id = ${leaseId} and charge_type = 'base_rent' limit 1`)).rows[0]!.id;
      const escalated = await db.transaction(async (tx) => {
        await tx.execute(sql`
          update lease_charges set effective_to = date '2026-05-31'
           where id = ${predecessor} and org_id = ${orgId}`);
        return (await tx.execute(sql`
          insert into lease_charges (org_id, lease_id, charge_type, description, amount, frequency, effective_from)
          values (${orgId}, ${leaseId}, 'base_rent', 'Escalated rent', '1100.0000', 'monthly', '2026-06-01')
          returning id`)).rows.length;
      });
      assert.equal(escalated, 1, "adjacent escalation windows are not overlap");

      // A different lease of the same property never competes with this one.
      await db.execute(sql`
        insert into lease_charges (org_id, lease_id, charge_type, description, amount, frequency, effective_from)
        values (${orgId}, ${fx.leases.unauthoredLeaseId}, 'base_rent', 'Sibling rent', '900.0000', 'monthly', '2026-05-01')`);
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "a duplicated-rent injection attempt still bills exactly one rent line per period",
  { skip: !DB },
  async () => {
    const fx = await seedPropertyFixture();
    try {
      const orgId = fx.org.orgId;
      const operatorId = await createScratchUser(orgId, "Rent Controller", "admin");
      const leaseId = fx.leases.authoredLeaseId;

      // The exact request the old API accepted and then double-billed is now
      // refused by storage before any schedule line can be generated from it.
      const injection = await db.execute(sql`
        insert into lease_charges (org_id, lease_id, charge_type, description, amount, frequency, effective_from)
        values (${orgId}, ${leaseId}, 'base_rent', 'Duplicate rent', '1000.0000', 'monthly', '2026-04-01')`)
        .then(() => "inserted", (error: unknown) => pgMessage(error));
      assert.match(String(injection), /lease_charges_base_rent_no_overlap/, "duplicate rent never reaches scheduling");

      // Canonical rent evolution through a controlled escalation: May closes
      // the day before June begins, June bills at the escalated amount.
      const escalation = await addLeaseEscalation({
        orgId,
        actorId: operatorId,
        leaseId,
        effectiveOn: "2026-06-01",
        method: "fixed",
        value: "100",
        requestId: `escalation-${randomUUID()}`,
      });
      const applied = await applyLeaseEscalation(orgId, operatorId, escalation.id);
      assert.equal(applied.newAmount, "1100.0000");

      // Scheduler ticks over two months under system provenance.
      await runDuePropertyBilling("2026-04-20");
      await runDuePropertyBilling("2026-06-20");

      const rentLines = (await db.execute<{ period: string; lines: number; amounts: number; invoiced: number }>(sql`
        select s.period_starts_on::text as period, count(*)::int as lines,
               count(distinct s.amount)::int as amounts,
               count(*) filter (where s.status = 'invoiced')::int as invoiced
          from lease_schedule_lines s join lease_charges c on c.id = s.charge_id and c.org_id = s.org_id
         where s.org_id = ${orgId} and s.lease_id = ${leaseId} and c.charge_type = 'base_rent'
           and s.period_starts_on < date '2026-07-01'
         group by s.period_starts_on order by s.period_starts_on`)).rows;
      assert.deepEqual(
        rentLines.map((row) => [row.period, row.lines, row.amounts]),
        [
          ["2026-04-01", 1, 1],
          ["2026-05-01", 1, 1],
          ["2026-06-01", 1, 1],
        ],
        "exactly one rent line per period, ever",
      );
      assert.deepEqual(rentLines.map((row) => row.invoiced), [1, 1, 1], "every period billed once");
      const juneAmount = await db.execute<{ amount: string }>(sql`
        select s.amount::text as amount from lease_schedule_lines s join lease_charges c on c.id = s.charge_id and c.org_id = s.org_id
         where s.org_id = ${orgId} and s.lease_id = ${leaseId} and c.charge_type = 'base_rent'
           and s.period_starts_on = date '2026-06-01'`);
      assert.equal(juneAmount.rows[0]?.amount, "1100.0000", "June carries the escalated rent");

      // Scheduler lineage marker survives unchanged: system provenance for
      // scheduler-generated batches, no editor impersonation anywhere.
      const markers = (await db.execute<{ systemMarkers: number; impersonated: number }>(sql`
        select count(*) filter (where changes->>'source' = 'scheduler' and actor_id is null)::int as "systemMarkers",
               count(*) filter (where actor_id = ${fx.historicalAuthorId})::int as impersonated
          from audit_log
         where org_id = ${orgId} and table_name = 'property_leases'
           and row_id = ${leaseId} and action = 'schedule_generated'`)).rows[0]!;
      assert.ok(markers.systemMarkers > 0, "scheduler batches keep their system lineage marker");
      assert.equal(markers.impersonated, 0, "scheduler lines never impersonate the editor");
    } finally {
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);

test(
  "every financial-term write records complete canonical audit evidence in its own transaction",
  { skip: !DB },
  async () => {
    const fx = await seedPropertyFixture();
    try {
      const orgId = fx.org.orgId;
      const actorId = await createScratchUser(orgId, "Term Auditor", "admin");
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
        values (${orgId}, ${fx.org.customerId}, ${fx.org.accounts.ar}, '0', 'CAD', false, ${actorId}, ${actorId})`);

      const requestId = `lease-create-${randomUUID()}`;
      const lease = await createPropertyLease({
        orgId,
        actorId,
        propertyId: fx.propertyId,
        tenantId: fx.org.customerId,
        leaseNumber: "L-AUDIT-1",
        startsOn: "2026-07-01",
        endsOn: "2027-06-30",
        baseRent: "2100",
        billingDay: 5,
        paymentTermsDays: 12,
        securityDepositRequired: "1500",
        camMethod: "pro_rata",
        camSharePercent: "12.5",
        lateFeeType: "fixed",
        lateFeeValue: "30",
        graceDays: 3,
        autoInvoice: true,
        autoPost: true,
        requestId,
      });

      // Surface 1: create lease — full after-state, actor, request correlation.
      const created = (await db.execute<{ actor: string | null; requestId: string | null; after: Record<string, unknown> }>(sql`
        select actor_id::text as actor, request_id as "requestId", changes->'after' as after
          from audit_log
         where org_id = ${orgId} and table_name = 'property_leases' and row_id = ${lease.id}
           and action = 'insert'`)).rows;
      assert.equal(created.length, 1);
      assert.equal(created[0]!.actor, actorId);
      assert.equal(created[0]!.requestId, requestId);
      const createAfter = created[0]!.after;
      assert.deepEqual(
        Object.keys(createAfter).sort(),
        ["autoInvoice", "autoPost", "baseRent", "billingDay", "camMethod", "camSharePercent", "endsOn", "graceDays",
          "lateFeeType", "lateFeeValue", "leaseNumber", "paymentTermsDays", "propertyId", "securityDepositRequired",
          "startsOn", "tenantId", "unitId"].sort(),
        "create audit covers every financial term",
      );
      assert.equal(String(createAfter.baseRent), "2100.0000");

      // Surface 2: update lease — canonical before/after plus changed fields.
      const updateRequestId = `lease-update-${randomUUID()}`;
      await updatePropertyLease({
        orgId,
        actorId,
        leaseId: lease.id,
        propertyId: fx.propertyId,
        tenantId: fx.org.customerId,
        leaseNumber: "L-AUDIT-2",
        startsOn: "2026-07-01",
        endsOn: "2027-09-30",
        baseRent: "2200",
        billingDay: 8,
        paymentTermsDays: 20,
        securityDepositRequired: "1800",
        camMethod: "pro_rata",
        camSharePercent: "15",
        lateFeeType: "percent",
        lateFeeValue: "5",
        graceDays: 4,
        autoInvoice: true,
        autoPost: false,
        requestId: updateRequestId,
      });
      const updated = (await db.execute<{
        before: Record<string, unknown>; after: Record<string, unknown>;
        changedFields: string[]; actor: string | null; requestId: string | null;
      }>(sql`
        select changes->'before' as before, changes->'after' as after, changes->'changedFields' as "changedFields",
               actor_id::text as actor, request_id as "requestId"
          from audit_log
         where org_id = ${orgId} and table_name = 'property_leases' and row_id = ${lease.id}
           and action = 'update'`)).rows;
      assert.equal(updated.length, 1);
      assert.equal(updated[0]!.actor, actorId);
      assert.equal(updated[0]!.requestId, updateRequestId);
      const changed = (updated[0]!.changedFields ?? []) as string[];
      for (const field of ["leaseNumber", "endsOn", "baseRent", "billingDay", "paymentTermsDays",
        "securityDepositRequired", "camSharePercent", "lateFeeType", "lateFeeValue", "graceDays", "autoPost"]) {
        assert.ok(changed.includes(field), `${field} appears in changedFields (got ${JSON.stringify(changed)})`);
      }
      assert.equal(String(updated[0]!.before.baseRent), "2100.0000");
      assert.equal(String(updated[0]!.after.baseRent), "2200.0000");
      assert.equal(String(updated[0]!.before.lateFeeValue), "30.0000");
      assert.equal(String(updated[0]!.after.lateFeeValue), "5.0000");

      // Surface 3: addCharge writes the material row only together with its
      // audit evidence in one transaction.
      const chargeRequestId = `charge-add-${randomUUID()}`;
      const charge = await addLeaseCharge({
        orgId,
        actorId,
        leaseId: lease.id,
        chargeType: "parking",
        description: "Reserved stall",
        amount: "85",
        frequency: "monthly",
        effectiveFrom: "2026-08-01",
        requestId: chargeRequestId,
      });
      const chargeAudit = (await db.execute<{ actor: string | null; requestId: string | null; after: Record<string, unknown> }>(sql`
        select actor_id::text as actor, request_id as "requestId", changes->'after' as after
          from audit_log
         where org_id = ${orgId} and table_name = 'lease_charges' and row_id = ${charge.id}
           and action = 'insert'`)).rows;
      assert.equal(chargeAudit.length, 1);
      assert.equal(chargeAudit[0]!.actor, actorId);
      assert.equal(chargeAudit[0]!.requestId, chargeRequestId);
      assert.equal(String(chargeAudit[0]!.after.chargeType), "parking");
      assert.equal(String(chargeAudit[0]!.after.amount), "85.0000");

      // Surface 4: addEscalation persists audit evidence beside the scheduled
      // change (apply-side before/after already audits previousAmount/newAmount).
      const escRequestId = `escalation-add-${randomUUID()}`;
      const escalation = await addLeaseEscalation({
        orgId,
        actorId,
        leaseId: lease.id,
        effectiveOn: "2027-01-01",
        method: "percent",
        value: "4",
        requestId: escRequestId,
      });
      const escalationAudit = (await db.execute<{ actor: string | null; requestId: string | null; after: Record<string, unknown> }>(sql`
        select actor_id::text as actor, request_id as "requestId", changes->'after' as after
          from audit_log
         where org_id = ${orgId} and table_name = 'lease_escalations' and row_id = ${escalation.id}
           and action = 'insert'`)).rows;
      assert.equal(escalationAudit.length, 1);
      assert.equal(escalationAudit[0]!.actor, actorId);
      assert.equal(escalationAudit[0]!.requestId, escRequestId);
      assert.deepEqual(
        Object.keys(escalationAudit[0]!.after).sort().map(String),
        ["effectiveOn", "leaseId", "method", "value"],
      );

      // Forced audit failure rolls the material term change back: with this
      // org's audit_log inserts vetoed, the parking-style charge must vanish
      // again — proof that audit evidence commits inside the write's own
      // transaction instead of being best-effort afterwards. The veto trigger
      // fires only for this scratch org, so nothing else sharing the database
      // template instance is affected.
      const chargeCount = async () => Number((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from lease_charges where org_id = ${orgId} and lease_id = ${lease.id}`)).rows[0]!.n);
      const chargesBeforeVeto = await chargeCount();
      try {
        // CREATE TRIGGER is a utility statement: its WHEN clause cannot use
        // bind parameters, so the scratch org id is interpolated literally.
        await db.execute(sql.raw([
          "create function openbooks_test_audit_veto() returns trigger language plpgsql as $fn$",
          "begin",
          "  raise exception 'forced audit failure (test veto)' using errcode = 'P0001';",
          "end;",
          "$fn$",
        ].join("\n")));
        await db.execute(sql.raw(
          `create trigger openbooks_test_audit_veto_trg before insert on audit_log\n`
          + `  for each row when (new.org_id = '${orgId}'::uuid) execute function openbooks_test_audit_veto()`,
        ));

        await assert.rejects(
          addLeaseCharge({
            orgId,
            actorId,
            leaseId: lease.id,
            chargeType: "storage",
            description: "Cage unit",
            amount: "40",
            frequency: "monthly",
            effectiveFrom: "2026-08-01",
          }),
          /forced audit failure \(test veto\)/,
        );
        assert.equal(await chargeCount(), chargesBeforeVeto, "the material charge rolled back with its failed audit");
      } finally {
        await db.execute(sql`drop trigger if exists openbooks_test_audit_veto_trg on audit_log`);
        await db.execute(sql`drop function if exists openbooks_test_audit_veto() cascade`);
      }

      // Without the veto the identical write succeeds and carries its audit.
      const retried = await addLeaseCharge({
        orgId,
        actorId,
        leaseId: lease.id,
        chargeType: "storage",
        description: "Cage unit",
        amount: "40",
        frequency: "monthly",
        effectiveFrom: "2026-08-01",
      });
      const retriedAudit = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${orgId} and table_name = 'lease_charges' and row_id = ${retried.id} and action = 'insert'`)).rows[0]!.n;
      assert.equal(retriedAudit, 1);
      assert.equal(await chargeCount(), chargesBeforeVeto + 2);
    } finally {
      await db.execute(sql`drop trigger if exists openbooks_test_audit_veto_trg on audit_log`);
      await db.execute(sql`drop function if exists openbooks_test_audit_veto() cascade`);
      await dropScratchOrgReporting(fx.org.orgId);
    }
  },
);
