import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function secondCalendar(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into fiscal_calendars
      (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
       adjustment_period_enabled, is_default, is_active, config)
    values (${id}, ${orgId}, 'Secondary', 'monthly',
            1, 1, 'UTC', false, false, true, '{}'::jsonb)`);
  return id;
}

async function addPeriod(
  orgId: string,
  calendarId: string,
  year: number,
  num: number,
  name: string,
  start: string,
  end: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${id}, ${orgId}, ${year}, ${num}, ${name}, ${start}, ${end}, false, ${calendarId})`);
  return id;
}

/** A second legal entity that reports on the given calendar from its first
 * period: each entity posts in its own calendar's periods. */
async function entityOnCalendar(org: Org, calendarId: string, from: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'Secondary calendar entity', 'CAD', 'CA')`);
  await db.execute(sql`
    insert into subsidiary_accounting_preferences (org_id, subsidiary_id, effective_from, fiscal_calendar_id, reason)
    values (${org.orgId}, ${id}, ${from}, ${calendarId}, 'Entity reporting calendar assignment')`);
  return id;
}

async function postEntry(
  org: Org,
  opts: {
    number: string;
    date: string;
    periodId: string;
    status: "draft" | "posted";
    subsidiaryId?: string;
  },
): Promise<string> {
  const entryId = randomUUID();
  const subsidiaryId = opts.subsidiaryId ?? org.subsidiaryId;
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${subsidiaryId}, ${opts.number},
            ${opts.date}, ${opts.periodId}, ${opts.number}, 'draft', 'manual')`);
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
    values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, ${subsidiaryId},
            100, 'CAD', 100, 1, ${org.customerId}, true),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, ${subsidiaryId},
            -100, 'CAD', -100, 1, null, false)`);
  if (opts.status === "posted") {
    await db.execute(
      sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId} and org_id = ${org.orgId}`,
    );
  }
  return entryId;
}

async function sandboxEntryNumbers(sandboxOrgId: string): Promise<string[]> {
  return (
    await db.execute<{ entry_number: string }>(
      sql`
    select entry_number from journal_entries where org_id = ${sandboxOrgId} order by entry_number`,
      "objects",
    )
  ).map((row) => row.entry_number);
}

async function deleteSandboxesFor(productionOrgId: string, name: string): Promise<void> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from sandboxes where production_org_id = ${productionOrgId} and name = ${name}`,
    "objects",
  );
  for (const row of rows) await deleteSandbox(row.id);
}

test(
  "an as-of clone cuts by posting date across calendars, not by period ordinal",
  { skip: !DB },
  async () => {
    // Calendar A (default) FY2026/P7 ends Jul 31; calendar B FY2026/P7 ends
    // Aug 31. The old ordinal filter copied every P<=7 period of EVERY
    // calendar, so a B entry posted in August landed in a "Jul 31 as-of"
    // sandbox even though its period closes later.
    const org = await createScratchOrg();
    const sandboxName = `As-of calendars ${randomUUID()}`;
    try {
      const b = await secondCalendar(org.orgId);
      const bJun = await addPeriod(
        org.orgId,
        b,
        2026,
        6,
        "SEC-2026-06",
        "2026-06-01",
        "2026-06-30",
      );
      const bJul = await addPeriod(
        org.orgId,
        b,
        2026,
        7,
        "SEC-2026-07",
        "2026-07-01",
        "2026-08-31",
      );
      const bEntity = await entityOnCalendar(org, b, "2026-06-01");
      await postEntry(org, {
        number: "A-POSTED-JUL",
        date: "2026-07-15",
        periodId: org.periodId,
        status: "posted",
      });
      await postEntry(org, {
        number: "B-POSTED-JUN",
        date: "2026-06-15",
        periodId: bJun,
        status: "posted",
        subsidiaryId: bEntity,
      });
      await postEntry(org, {
        number: "B-DRAFT-AUG",
        date: "2026-08-05",
        periodId: bJul,
        status: "draft",
        subsidiaryId: bEntity,
      });

      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: sandboxName,
        tier: "as_of",
        masked: false,
        asOfPeriodId: org.periodId,
      });
      assert.deepEqual(await sandboxEntryNumbers(created.sandboxOrgId), [
        "A-POSTED-JUL",
        "B-POSTED-JUN",
      ]);
      const augustLines = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from journal_lines l
        join journal_entries e on e.id = l.entry_id
       where l.org_id = ${created.sandboxOrgId} and e.entry_number = 'B-DRAFT-AUG'`,
          "objects",
        )
      )[0]!.n;
      assert.equal(augustLines, 0, "the post-cutoff draft entry's lines must not copy either");
    } finally {
      await deleteSandboxesFor(org.orgId, sandboxName).catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);

test("the as-of preflight refusal agrees exactly with the copy filter", { skip: !DB }, async () => {
  // Same two-calendar shape, but the August B entry is POSTED: its documents
  // would point at an entry the copy drops, so create must refuse — naming
  // the cutoff by date and calendar with an actionable remedy — instead of
  // committing a torn clone or dying on a deferred foreign key.
  const org = await createScratchOrg();
  const sandboxName = `As-of refusal ${randomUUID()}`;
  try {
    const b = await secondCalendar(org.orgId);
    const bJul = await addPeriod(org.orgId, b, 2026, 7, "SEC-2026-07", "2026-07-01", "2026-08-31");
    const bEntity = await entityOnCalendar(org, b, "2026-07-01");
    await postEntry(org, {
      number: "B-POSTED-AUG",
      date: "2026-08-05",
      periodId: bJul,
      status: "posted",
      subsidiaryId: bEntity,
    });

    await assert.rejects(
      createSandbox({
        productionOrgId: org.orgId,
        name: sandboxName,
        tier: "as_of",
        masked: false,
        asOfPeriodId: org.periodId,
      }),
      /period P07 FY2026 ending 2026-07-31.*calendar "Default".*1 posted entries.*dated after 2026-07-31.*or use a full tier/s,
    );
    // The refusal is raised, not dropped: the failed sandbox row carries it.
    const failed = (
      await db.execute<{ status: string; last_error: string | null }>(
        sql`
      select status, last_error from sandboxes
       where production_org_id = ${org.orgId} and name = ${sandboxName}`,
        "objects",
      )
    )[0]!;
    assert.equal(failed.status, "failed");
    assert.match(failed.last_error ?? "", /dated after 2026-07-31/);
  } finally {
    await deleteSandboxesFor(org.orgId, sandboxName).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});

test(
  "the clone resolves the cutoff inside its snapshot, not from an outer lookup",
  { skip: !DB },
  async () => {
    // Deterministic interleave for the SBOX1-addendum race: read the cutoff
    // the way the old outer lookup did (Jul 31), commit a relabel of the
    // cutoff row before the clone snapshot opens, and prove the clone uses the
    // in-snapshot identity (Aug 31) — the old code refused this clone.
    const org = await createScratchOrg();
    const sandboxName = `As-of interleave ${randomUUID()}`;
    try {
      const calendar = (
        await db.execute<{ fiscal_calendar_id: string }>(
          sql`
      select fiscal_calendar_id from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!.fiscal_calendar_id;
      const augustId = await addPeriod(
        org.orgId,
        calendar,
        2026,
        8,
        "2026-08",
        "2026-08-01",
        "2026-08-31",
      );
      await postEntry(org, {
        number: "POSTED-AUG",
        date: "2026-08-05",
        periodId: augustId,
        status: "posted",
      });

      const outer = (
        await db.execute<{ ends_on: string }>(
          sql`
      select ends_on::text as ends_on from accounting_periods where id = ${org.periodId}`,
          "objects",
        )
      )[0]!.ends_on;
      assert.equal(outer, "2026-07-31", "the pre-fix outer lookup consumed this identity");
      await db.execute(
        sql`update accounting_periods set ends_on = '2026-08-31' where id = ${org.periodId}`,
      );

      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: sandboxName,
        tier: "as_of",
        masked: false,
        asOfPeriodId: org.periodId,
      });
      assert.deepEqual(await sandboxEntryNumbers(created.sandboxOrgId), ["POSTED-AUG"]);
    } finally {
      await deleteSandboxesFor(org.orgId, sandboxName).catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a relabel-free clone still refuses post-cutoff postings (single-calendar control)",
  { skip: !DB },
  async () => {
    // Control for the interleave above: without the relabel, the same fixture
    // refuses, so the interleave success proves in-snapshot resolution rather
    // than a refusal that never fires.
    const org = await createScratchOrg();
    const sandboxName = `As-of control ${randomUUID()}`;
    try {
      const calendar = (
        await db.execute<{ fiscal_calendar_id: string }>(
          sql`
      select fiscal_calendar_id from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!.fiscal_calendar_id;
      const augustId = await addPeriod(
        org.orgId,
        calendar,
        2026,
        8,
        "2026-08",
        "2026-08-01",
        "2026-08-31",
      );
      await postEntry(org, {
        number: "POSTED-AUG",
        date: "2026-08-05",
        periodId: augustId,
        status: "posted",
      });

      await assert.rejects(
        createSandbox({
          productionOrgId: org.orgId,
          name: sandboxName,
          tier: "as_of",
          masked: false,
          asOfPeriodId: org.periodId,
        }),
        /dated after 2026-07-31/,
      );
    } finally {
      await deleteSandboxesFor(org.orgId, sandboxName).catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a settings change between the org read and the copy reaches the sandbox (SBOX2)",
  { skip: !DB },
  async () => {
    // Deterministic interleave for the create path: a trigger applies a
    // Company Settings change when the provisional sandbox org row inserts —
    // after create's outer config read, before runClone's snapshot. The ready
    // sandbox must carry the snapshot's configuration, never the stale read.
    // The provisional row inserts in the new sandbox's tenant scope, so the
    // injected change runs with its owner's rights to reach the production row.
    const org = await createScratchOrg();
    const sandboxName = `Config race ${randomUUID()}`;
    const fault = `openbooks_sandbox_config_${randomUUID().replaceAll("-", "")}`;
    try {
      await postEntry(org, {
        number: "RACE-POSTED",
        date: "2026-07-15",
        periodId: org.periodId,
        status: "posted",
      });
      await db.execute(
        sql.raw(`
      create function "${fault}"() returns trigger language plpgsql security definer set search_path = public, pg_catalog as $fn$
      begin
        if new.env_kind = 'sandbox' then
          update orgs
             set legal_name = 'SBOX2 Updated Legal',
                 settings = coalesce(settings, '{}'::jsonb) || '{"sbox2_probe":"updated"}'::jsonb
           where id = '${org.orgId}';
        end if;
        return new;
      end
      $fn$`),
      );
      await db.execute(
        sql.raw(`
      create trigger "${fault}_trg"
        before insert on orgs
        for each row
        execute function "${fault}"()`),
      );

      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: sandboxName,
        tier: "full",
        masked: false,
      });
      const state = (
        await db.execute<{
          status: string;
          name: string;
          legal_name: string | null;
          probe: string | null;
          entries: number;
        }>(
          sql`
      select (select status from sandboxes where id = ${created.sandboxId}) as status,
             org.name, org.legal_name,
             org.settings ->> 'sbox2_probe' as probe,
             (select count(*)::int from journal_entries
               where org_id = ${created.sandboxOrgId} and entry_number = 'RACE-POSTED') as entries
        from orgs org
       where org.id = ${created.sandboxOrgId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(state, {
        status: "ready",
        // The sandbox keeps its own display name: only source configuration is
        // captured, and the capture below is the snapshot's, not the stale read's.
        name: sandboxName,
        legal_name: "SBOX2 Updated Legal",
        probe: "updated",
        entries: 1,
      });
    } finally {
      await db
        .execute(sql.raw(`drop trigger if exists "${fault}_trg" on orgs`))
        .catch(() => undefined);
      await db.execute(sql.raw(`drop function if exists "${fault}"()`)).catch(() => undefined);
      await deleteSandboxesFor(org.orgId, sandboxName).catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);
