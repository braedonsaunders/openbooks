import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  createObligationsFromInvoice,
  revenueContractPostingEffectKey,
  revenueObligationPostingEffectKey,
  runRevenueRecognition,
} from "./revenue-recognition.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresFailure(error: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code) return candidate;
    current = candidate.cause;
  }
  return null;
}

async function rejectsUnique(
  work: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const failure = postgresFailure(error);
    assert.equal(failure?.code, "23505");
    assert.equal(failure?.constraint, constraint);
    return true;
  });
}

/** One rev-rec invoice line whose obligation must carry a recognition plan. */
async function seedRevRecInvoice(
  org: { orgId: string; customerId: string; subsidiaryId: string; date: string; items: { service: string } },
  lineCustom: Record<string, unknown> = {},
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, custom)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${`REV-IDEM-${documentId}`},
            ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, description,
       quantity, unit_price, amount, tax_amount, custom)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.service},
            'Recognition replay', '1', '120', '120', '0', ${JSON.stringify(lineCustom)}::jsonb)
  `);
  return { documentId, lineId };
}

/**
 * Recognition fixtures span the twelve months beginning in the scratch org's
 * July 2026 open period. Keep those additional periods local to this suite so
 * the general scratch fixture can remain intentionally minimal.
 */
async function ensureRecognitionPeriods(orgId: string): Promise<void> {
  const calendar = await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars
     where org_id = ${orgId} and is_default = true
     limit 1`);
  const calendarId = calendar.rows[0]?.id;
  assert.ok(calendarId, "scratch org has a default fiscal calendar");

  for (let offset = 1; offset < 12; offset += 1) {
    const month = 6 + offset;
    const year = 2026 + Math.floor(month / 12);
    const monthNumber = (month % 12) + 1;
    const start = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
    const endDate = new Date(Date.UTC(year, monthNumber, 0));
    const end = `${year}-${String(monthNumber).padStart(2, "0")}-${String(endDate.getUTCDate()).padStart(2, "0")}`;
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
         is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${orgId}, ${year}, ${monthNumber}, ${start.slice(0, 7)},
             ${start}, ${end}, false, ${calendarId}
       where not exists (
         select 1 from accounting_periods
          where org_id = ${orgId} and starts_on = ${start})`);
  }
}

interface ScheduleStateRow {
  [key: string]: unknown;
  book_code: string;
  schedule_id: string;
  period_id: string | null;
  sequence: number | null;
  planned: string | null;
  journal_entry_id: string | null;
}

/** The full recognition-plan surface of the org's obligations, one row per book per line. */
async function scheduleState(orgId: string): Promise<ScheduleStateRow[]> {
  const result = await db.execute<ScheduleStateRow>(sql`
    select b.code as book_code, s.id as schedule_id,
           l.period_id, l.sequence, l.planned_amount::text as planned,
           l.journal_entry_id
      from performance_obligations o
      join recognition_schedules s on s.obligation_id = o.id and s.org_id = o.org_id
      join accounting_books b on b.id = s.book_id and b.org_id = s.org_id
      left join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
     where o.org_id = ${orgId}
     order by b.code, l.sequence
  `);
  return result.rows;
}

test("duplicate inventory, revenue-contract, and obligation effects violate their storage keys", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const movementKey = `posting-effect:test:movement:${randomUUID()}`;
    const insertMovement = (id: string) => db.execute(sql`
      insert into inventory_movements
        (id, org_id, item_id, kind, moved_at, stock_location_id, quantity,
         status, idempotency_key)
      values (${id}, ${org.orgId}, ${org.items.fifo}, 'receipt', ${org.date},
              ${org.stockLocationId}, '1', 'pending', ${movementKey})
    `);
    await insertMovement(randomUUID());
    await rejectsUnique(
      () => insertMovement(randomUUID()),
      "inventory_movements_org_idempotency",
    );

    const contractId = randomUUID();
    const contractKey = `posting-effect:test:contract:${randomUUID()}`;
    const insertContract = (id: string, number: string) => db.execute(sql`
      insert into revenue_contracts
        (id, org_id, customer_id, contract_number, idempotency_key, status,
         total_transaction_price)
      values (${id}, ${org.orgId}, ${org.customerId}, ${number}, ${contractKey},
              'active', '100')
    `);
    await insertContract(contractId, `CONTRACT-${contractId}`);
    await rejectsUnique(
      () => insertContract(randomUUID(), `CONTRACT-${randomUUID()}`),
      "revenue_contracts_org_idempotency",
    );

    const obligationKey = `posting-effect:test:obligation:${randomUUID()}`;
    const insertObligation = (id: string) => db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, idempotency_key, description,
         recognition_rule_id, allocated_price, status)
      values (${id}, ${org.orgId}, ${contractId}, ${obligationKey},
              'Storage-key obligation', ${org.recognitionRuleId}, '100', 'open')
    `);
    await insertObligation(randomUUID());
    await rejectsUnique(
      () => insertObligation(randomUUID()),
      "performance_obligations_org_idempotency",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent invoice obligation creation converges on one contract and one obligation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const documentId = randomUUID();
  const lineId = randomUUID();
  try {
    await ensureRecognitionPeriods(org.orgId);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, status, custom)
      values (${documentId}, ${org.orgId}, 'customer_invoice', ${`REV-IDEM-${documentId}`},
              ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, description,
         quantity, unit_price, amount, tax_amount, custom)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.service},
              'Concurrent subscription', '1', '120', '120', '0', '{}'::jsonb)
    `);

    const results = await Promise.all([
      createObligationsFromInvoice(documentId, org.orgId, null),
      createObligationsFromInvoice(documentId, org.orgId, null),
    ]);
    assert.equal(results.reduce((total, result) => total + result.created, 0), 1);

    const stored = await db.execute<{
      contracts: number;
      obligations: number;
      contract_key: string;
      obligation_key: string;
    }>(sql`
      select count(distinct contract.id)::int as contracts,
             count(obligation.id)::int as obligations,
             min(contract.idempotency_key) as contract_key,
             min(obligation.idempotency_key) as obligation_key
        from revenue_contracts contract
        join performance_obligations obligation on obligation.contract_id=contract.id
       where contract.org_id=${org.orgId}
         and contract.idempotency_key=${revenueContractPostingEffectKey(documentId)}
    `);
    assert.deepEqual(stored.rows, [{
      contracts: 1,
      obligations: 1,
      contract_key: revenueContractPostingEffectKey(documentId),
      obligation_key: revenueObligationPostingEffectKey(lineId),
    }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("replay after a crash between obligation commit and schedule build converges to one complete plan per book", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await ensureRecognitionPeriods(org.orgId);
    const { documentId } = await seedRevRecInvoice(org);
    assert.equal((await createObligationsFromInvoice(documentId, org.orgId, null)).created, 1);
    const baseline = await scheduleState(org.orgId);
    const glBooks = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from accounting_books
       where org_id = ${org.orgId} and is_active and posts_gl`);
    assert.equal(baseline.length, 12, "one twelve-month plan for the primary book");
    assert.equal(glBooks.rows[0]!.n, 1);

    // Crash aftermath: the obligations committed, the schedule writes did not.
    await db.execute(sql`
      delete from recognition_schedule_lines where org_id = ${org.orgId}`);
    await db.execute(sql`
      delete from recognition_schedules where org_id = ${org.orgId}`);

    // The outbox drain replays the same posting effect; it must never duplicate
    // obligations and must repair every missing book's plan.
    const replay = await createObligationsFromInvoice(documentId, org.orgId, null);
    assert.equal(replay.created, 0);

    const repaired = await scheduleState(org.orgId);
    assert.equal(new Set(repaired.map((r) => r.schedule_id)).size, glBooks.rows[0]!.n);
    assert.deepEqual(
      repaired.map(({ book_code, period_id, sequence, planned, journal_entry_id }) => ({
        book_code,
        period_id,
        sequence,
        planned,
        journal_entry_id,
      })),
      baseline.map(({ book_code, period_id, sequence, planned, journal_entry_id }) => ({
        book_code,
        period_id,
        sequence,
        planned,
        journal_entry_id,
      })),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("replay repairs the failed book of a multi-book build and preserves posted history without duplicate lines", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await ensureRecognitionPeriods(org.orgId);
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${randomUUID()}, ${org.orgId}, 'SEC', 'Secondary', false, true, true)`);

    const { documentId } = await seedRevRecInvoice(org);
    assert.equal((await createObligationsFromInvoice(documentId, org.orgId, null)).created, 1);
    const baseline = await scheduleState(org.orgId);
    assert.equal(baseline.length, 24, "one twelve-month plan for each GL book");

    // Midway through a multi-book build failure aftermath: only the primary
    // book's plan survived; the secondary never got a schedule.
    await db.execute(sql`
      delete from recognition_schedule_lines
       where org_id = ${org.orgId}
         and schedule_id in (
           select s.id from recognition_schedules s
             join accounting_books b on b.id = s.book_id and b.org_id = s.org_id
            where s.org_id = ${org.orgId} and b.code = 'SEC')`);
    await db.execute(sql`
      delete from recognition_schedules s
       using accounting_books b
       where s.book_id = b.id and s.org_id = b.org_id and s.org_id = ${org.orgId} and b.code = 'SEC'`);

    // While the secondary book was dark, the primary recognized its due month.
    const actor = await createScratchUser(org.orgId, "Admin", "admin");
    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actor);
    assert.equal(run.posted, 1);
    const postedPrimary = (await scheduleState(org.orgId)).find(
      (r) => r.book_code === "PRI" && r.sequence === 0,
    );
    assert.ok(postedPrimary?.journal_entry_id);

    const replay = await createObligationsFromInvoice(documentId, org.orgId, null);
    assert.equal(replay.created, 0);

    const repaired = await scheduleState(org.orgId);
    assert.equal(repaired.length, baseline.length);
    assert.equal(new Set(repaired.map((r) => r.schedule_id)).size, 2);
    const planShape = (rows: ScheduleStateRow[]) => rows
      .map(({ book_code, period_id, planned }) => ({ book_code, period_id, planned }))
      .sort((a, b) => `${a.book_code}:${a.period_id}`.localeCompare(`${b.book_code}:${b.period_id}`));
    assert.deepEqual(planShape(repaired), planShape(baseline),
      "replay preserves every book's period amounts without duplicate lines");
    const priAfter = repaired.find((r) => r.book_code === "PRI");
    const secAfter = repaired.find((r) => r.book_code === "SEC");
    assert.equal(
      priAfter?.journal_entry_id,
      postedPrimary.journal_entry_id,
      "replay must not disturb or duplicate posted history",
    );
    assert.ok(!secAfter?.journal_entry_id, "the regenerated plan starts unposted");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a schedule-build failure during obligation creation commits nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // An inverted term makes the plan computation throw; the whole effect —
    // contract, obligations AND schedules — must roll back atomically instead
    // of leaving committed obligations that can never recognize.
    const { documentId, lineId } = await seedRevRecInvoice(org, {
      recognitionStartsOn: "2026-07-15",
      recognitionEndsOn: "2026-07-14",
    });
    await assert.rejects(
      () => createObligationsFromInvoice(documentId, org.orgId, null),
      /precedes the recognition start/,
    );

    const persisted = await db.execute<{
      contracts: number;
      obligations: number;
      schedules: number;
    }>(sql`
      select (select count(*)::int from revenue_contracts
               where org_id = ${org.orgId}
                 and idempotency_key = ${revenueContractPostingEffectKey(documentId)}) as contracts,
             (select count(*)::int from performance_obligations
               where org_id = ${org.orgId} and document_line_id = ${lineId}) as obligations,
             (select count(*)::int from recognition_schedules
               where org_id = ${org.orgId}) as schedules
    `);
    assert.deepEqual(persisted.rows[0], { contracts: 0, obligations: 0, schedules: 0 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
