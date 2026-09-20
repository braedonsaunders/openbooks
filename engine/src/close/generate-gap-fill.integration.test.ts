import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { CloseError, generateAccountingPeriods } from "./close.ts";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

/**
 * Gap-fill regression (F-t06-007, corroborated F-t09-003/F-t08-006): seeded
 * tenants carry 2026-05..08 named `2026-05` (not the canonical `P05 FY2026`)
 * with ledger activity, and no 2026-09..12 at all. Regenerating the year must
 * create the missing months without touching the active rows — a cosmetic
 * name drift is not a date regeneration, and one blocked re-date must not
 * roll back unrelated creations.
 */

async function defaultCalendarId(orgId: string): Promise<string> {
  const found = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars
     where org_id = ${orgId} and is_default and is_active
     limit 1`)).rows[0]?.id;
  assert.ok(found, "scratch org must seed a default fiscal calendar");
  return found;
}

async function postIntoPeriod(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  bankId: string,
  revenueId: string,
  periodId: string,
  date: string,
): Promise<void> {
  const entry = randomUUID();
  const memo = `gapfill-${date}-${entry.slice(0, 8)}`;
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entry}, ${orgId}, ${bookId}, ${subsidiaryId}, ${memo}, ${date}, ${periodId}, ${memo}, 'draft', 'manual')`);
  await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values (${orgId}, ${entry}, 1, ${bankId}, ${subsidiaryId}, '10.0000', 'CAD', '10.0000', '1'),
           (${orgId}, ${entry}, 2, ${revenueId}, ${subsidiaryId}, '-10.0000', 'CAD', '-10.0000', '1')`);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
}

async function periodRow(orgId: string, periodNumber: number) {
  return (await db.execute<{
    id: string;
    name: string;
    starts_on: string;
    ends_on: string;
  }>(sql`
    select id, name, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods
     where org_id = ${orgId} and fiscal_year = 2026 and period_number = ${periodNumber}`))
    .rows[0];
}

/** Carve the SIM shape: 05..08 present with legacy names, 09..12 missing. */
async function carveSimShape(orgId: string): Promise<void> {
  await db.execute(sql`
    delete from period_locks
     where org_id = ${orgId}
       and period_id in (select id from accounting_periods
                          where org_id = ${orgId} and fiscal_year = 2026 and period_number >= 9)`);
  await db.execute(sql`
    delete from accounting_periods
     where org_id = ${orgId} and fiscal_year = 2026 and period_number >= 9`);
  for (const n of [5, 6, 7, 8]) {
    await db.execute(sql`
      update accounting_periods set name = ${`2026-0${n}`}
       where org_id = ${orgId} and fiscal_year = 2026 and period_number = ${n}`);
  }
}

test("gap-fill creates missing months past name-drifted active periods", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, "Calendar keeper", "admin");
      const calendarId = await defaultCalendarId(org.orgId);
      await generateAccountingPeriods(org.orgId, calendarId, 2026, actor);
      await carveSimShape(org.orgId);
      const may = await periodRow(org.orgId, 5);
      assert.ok(may, "expected a May period to seed activity into");
      await postIntoPeriod(org.orgId, org.bookId, org.subsidiaryId, org.accounts.bank, org.accounts.revenue, may.id, "2026-05-15");

      const result = await generateAccountingPeriods(org.orgId, calendarId, 2026, actor);

      assert.equal(result.created, 4, "Sep..Dec must be created");
      for (const n of [9, 10, 11, 12]) {
        assert.ok(await periodRow(org.orgId, n), `expected generated period ${n}`);
      }
      const sep = await periodRow(org.orgId, 9);
      assert.equal(sep?.name, "P09 FY2026");
      assert.equal(sep?.starts_on, "2026-09-01");
      assert.equal(sep?.ends_on, "2026-09-30");
      // The active May row keeps its posted label and dates: a name drift is
      // not a regeneration, and must not throw either.
      const mayAfter = await periodRow(org.orgId, 5);
      assert.equal(mayAfter?.name, "2026-05");
      assert.equal(mayAfter?.starts_on, "2026-05-01");
      assert.equal(mayAfter?.ends_on, "2026-05-31");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a genuine date conflict still throws but keeps the created months", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, "Calendar keeper", "admin");
      const calendarId = await defaultCalendarId(org.orgId);
      await generateAccountingPeriods(org.orgId, calendarId, 2026, actor);
      await carveSimShape(org.orgId);
      const aug = await periodRow(org.orgId, 8);
      assert.ok(aug, "expected an August period to seed activity into");
      await postIntoPeriod(org.orgId, org.bookId, org.subsidiaryId, org.accounts.bank, org.accounts.revenue, aug.id, "2026-08-15");
      // A real boundary change (not a name): shrink August by one day.
      await db.execute(sql`
        update accounting_periods set ends_on = '2026-08-30'
         where id = ${aug.id} and org_id = ${org.orgId}`);

      await assert.rejects(
        generateAccountingPeriods(org.orgId, calendarId, 2026, actor),
        (error: unknown) => error instanceof CloseError && /ledger activity/i.test(error.message),
      );
      // The guard stays loud, but the gap-fill it blocked on the way out
      // survives: September posting is unblocked.
      for (const n of [9, 10, 11, 12]) {
        assert.ok(await periodRow(org.orgId, n), `expected created period ${n} to survive the conflict`);
      }
      const augAfter = await periodRow(org.orgId, 8);
      assert.equal(augAfter?.ends_on, "2026-08-30", "the blocked re-date must not apply");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("name drift without activity converges to the canonical name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const actor = await createScratchUser(org.orgId, "Calendar keeper", "admin");
      const calendarId = await defaultCalendarId(org.orgId);
      await generateAccountingPeriods(org.orgId, calendarId, 2026, actor);
      await db.execute(sql`
        update accounting_periods set name = 'legacy-jul'
         where org_id = ${org.orgId} and fiscal_year = 2026 and period_number = 7`);

      const result = await generateAccountingPeriods(org.orgId, calendarId, 2026, actor);

      assert.equal((await periodRow(org.orgId, 7))?.name, "P07 FY2026");
      assert.ok(result.updated >= 1, "expected the rename to count as an update");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
