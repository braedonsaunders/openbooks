import { refusal } from "../../testing/refusal.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { seedBenefitIncentivePosting as postEntry } from "../../testing/benefit-incentive-posting.ts";
import { toUnits } from "../../money/money.ts";
import { setupHarness, withHarness, grantPermissions, mkDepartment, seedEmployment, setFeatures, restrictRole, mkSecondSubsidiary } from "../../testing/hrm-harness.ts";
import { BenefitsError } from "./errors.ts";
import {
  measureApprovedHours,
  measureMoneySource,
  resolvePeriodBasis,
  type HoursSourceConfig,
  type MoneySourceConfig,
} from "./incentives.ts";

/**
 * Incentive source measurement DB coverage (integration partition — run at
 * the integration gate; skips without OPENBOOKS_DB_URL): posted-GL money
 * bases with explicit account roles and GL-type binding, approved-hours
 * bases with per-employment attribution, fiscal-calendar basis resolution,
 * and every named refusal read back through the real code path.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const INCENTIVES_SPEC = {
  users: [
    { key: "ledgerId", name: "Incentives Ledger", handle: "incentives_ledger", permissions: ["hrm.benefits.read", "hrm.benefits.manage", "gl.read"], link: true },
    { key: "hrId", name: "Incentives HR", handle: "incentives_hr", permissions: ["hrm.benefits.read", "hrm.benefits.manage"], link: true },
  ],
} as const;

type Harness = Awaited<ReturnType<typeof setupHarness<typeof INCENTIVES_SPEC>>>;

async function extraExpenseAccount(orgId: string): Promise<string> {
  const id = randomUUID();
  const number = `61${String(Math.floor(Math.random() * 90) + 10)}`;
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, custom)
    values (${id}, ${orgId}, ${`X${number}_${id.slice(0, 4)}`}, 'Supplies', 'expense', false, true, false, false, '{}'::jsonb)
  `);
  return id;
}

async function moneyConfig(h: Harness, overrides: Partial<MoneySourceConfig> = {}): Promise<MoneySourceConfig> {
  const expense = await extraExpenseAccount(h.org.orgId);
  return {
    metric: "net_profit",
    scope: "company",
    departmentIds: [],
    projectIds: [],
    revenueAccountIds: [h.org.accounts.revenue],
    expenseAccountIds: [h.org.accounts.cogs, expense],
    legalEntityId: h.org.subsidiaryId,
    currency: "USD",
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    incentiveExpenseAccountId: null,
    allowedSubsidiaryIds: null,
    ...overrides,
  };
}

async function seedTime(
  h: Harness,
  partyId: string,
  opts: { date?: string; hours?: string; status?: string; department?: string | null; project?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into time_entries
      (id, org_id, employee_party_id, worked_on, hours, status, approved_at, department_id, project_id)
    values (${id}, ${h.org.orgId}, ${partyId}, ${opts.date ?? "2026-07-15"}::date,
            ${opts.hours ?? "8.0000"}, ${opts.status ?? "approved"}, now(),
            ${opts.department ?? null}, ${opts.project ?? null})
  `);
  return id;
}

const refuses = async (fn: () => unknown, pattern: RegExp) =>
  (await refusal(Promise.resolve().then(fn), BenefitsError, pattern)).message;

test("net profit measures posted revenue minus the explicit expense set", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h);
    // Revenue 1000 credit against bank; cogs 300 and supplies 100 debits.
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-1000.0000" },
      { account: h.org.accounts.bank, amount: "1000.0000" },
    ]);
    await postEntry(h, [
      { account: h.org.accounts.cogs, amount: "300.0000" },
      { account: h.org.accounts.bank, amount: "-300.0000" },
    ]);
    const supplies = cfg.expenseAccountIds[1]!;
    await postEntry(h, [
      { account: supplies, amount: "100.0000" },
      { account: h.org.accounts.bank, amount: "-100.0000" },
    ]);
    // A draft entry never enters the base.
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-5000.0000" },
      { account: h.org.accounts.bank, amount: "5000.0000" },
    ], { status: "draft" });
    const snapshot = await measureMoneySource(db, h.org.orgId, h.ledgerId, cfg);
    assert.equal(snapshot.value, "600.0000");
    assert.equal(snapshot.revenueTotal, "1000.0000");
    assert.equal(snapshot.expenseTotal, "400.0000");
    assert.equal(snapshot.currency, "USD");
    assert.equal(snapshot.entryCount, 3);
    assert.ok(snapshot.maxPostedAt !== null);
    assert.deepEqual([...snapshot.entryIds].sort(), [...snapshot.entryIds]);
    // The measure fences the primary posting book and digests exact lines.
    assert.equal(snapshot.bookId, h.org.bookId);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
    // Three measured lines: one per entry on the revenue/expense side
    // (bank offsets sit outside the measured accounts).
    assert.equal(snapshot.lineCount, 3);
    assert.equal(snapshot.postingFacts.length, 3);
    assert.equal(snapshot.postingFacts.reduce((sum, fact) => sum + -toUnits(fact.amount), 0n), 6000000n);
    // A parallel book duplicating the revenue never enters the base.
    const parallelBook = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${parallelBook}, ${h.org.orgId}, 'TAX-BALANCE', 'Tax representation', false, true, true)
    `);
    const dupEntry = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${dupEntry}, ${h.org.orgId}, ${parallelBook}, ${h.org.subsidiaryId},
                ${dupEntry}, '2026-07-15'::date, ${h.org.periodId}, 'draft', 'manual')
      `);
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${h.org.orgId}, ${dupEntry}, 1, ${h.org.accounts.revenue}, ${h.org.subsidiaryId},
                '-1000.0000', 'USD', '-1000.0000', 1),
               (${h.org.orgId}, ${dupEntry}, 2, ${h.org.accounts.bank}, ${h.org.subsidiaryId},
                '1000.0000', 'USD', '1000.0000', 1)
      `);
      await tx.execute(sql`
        update journal_entries set status = 'posted', posted_at = now() where id = ${dupEntry}
      `);
    });
    const fenced = await measureMoneySource(db, h.org.orgId, h.ledgerId, cfg);
    assert.equal(fenced.value, "600.0000");
    assert.equal(fenced.digest, snapshot.digest);
    assert.equal(fenced.bookId, h.org.bookId);
  });
});

test("entries outside the entity, period, or scope stay out of the base", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h, { metric: "revenue", expenseAccountIds: [] });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-1000.0000" },
      { account: h.org.accounts.bank, amount: "1000.0000" },
    ]);
    // June posting: outside the July span.
    const junePeriod = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${junePeriod}, ${h.org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false,
              (select id from fiscal_calendars where org_id = ${h.org.orgId} and is_default limit 1))
    `);
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-2000.0000" },
      { account: h.org.accounts.bank, amount: "2000.0000" },
    ], { date: "2026-06-15", periodId: junePeriod });
    const snapshot = await measureMoneySource(db, h.org.orgId, h.ledgerId, cfg);
    assert.equal(snapshot.value, "1000.0000");
  });
});

test("foreign-currency postings refuse instead of converting", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h, { metric: "revenue", expenseAccountIds: [] });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-100.0000" },
      { account: h.org.accounts.bank, amount: "100.0000" },
    ], { currency: "EUR" });
    const message = await refuses(
      () => measureMoneySource(db, h.org.orgId, h.ledgerId, cfg),
      /outside the program currency USD/,
    );
    assert.match(message, /EUR/);
  });
});

test("mis-typed accounts refuse against their actual GL type", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h, {
      revenueAccountIds: [h.org.accounts.cogs],
      expenseAccountIds: [h.org.accounts.revenue],
    });
    await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, cfg), /not income/);
  });
});

test("the program's own incentive expense inside the base refuses as circular", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h, { incentiveExpenseAccountId: h.org.accounts.cogs });
    await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, cfg), /shrink the next base/);
  });
});

test("profit measures require the ledger grant; HR access alone is refused", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h);
    await refuses(() => measureMoneySource(db, h.org.orgId, h.hrId, cfg), /gl\.read/);
  });
});

test("an entity outside the actor's scope is not found, never measured", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const cfg = await moneyConfig(h, { allowedSubsidiaryIds: new Set([randomUUID()]) });
    await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, cfg), /outside your scope/);
  });
});

test("a caller-supplied unrestricted lens cannot widen the actor's actual legal-entity scope", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const money = await moneyConfig(h, { metric: "revenue", expenseAccountIds: [] });
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
    const hours = hoursConfig(h, [worker.employmentId]);
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-100.0000" },
      { account: h.org.accounts.bank, amount: "100.0000" },
    ]);
    await seedTime(h, worker.workerPartyId);
    assert.equal((await measureMoneySource(db, h.org.orgId, h.ledgerId, money)).value, "100.0000");
    assert.equal((await measureApprovedHours(db, h.org.orgId, h.ledgerId, hours)).totalHours, "8.0000");
    // Preserve the grants while removing the employer from the native role scope.
    await restrictRole(h.org.orgId, "incentives_ledger", []);
    for (const suppliedScope of [null, new Set([h.org.subsidiaryId])]) {
      await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, { ...money, allowedSubsidiaryIds: suppliedScope }), /outside your scope/);
      await refuses(() => measureApprovedHours(db, h.org.orgId, h.ledgerId, { ...hours, allowedSubsidiaryIds: suppliedScope }), /outside your scope/);
    }
  });
});

test("department measures sum shaped postings and refuse un-shaped ones", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const dept = await mkDepartment(h.org.orgId, "Sales");
    const cfg = await moneyConfig(h, {
      metric: "revenue", expenseAccountIds: [], scope: "department", departmentIds: [dept],
    });
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-400.0000", department: dept },
      { account: h.org.accounts.bank, amount: "400.0000", department: dept },
    ]);
    const shaped = await measureMoneySource(db, h.org.orgId, h.ledgerId, cfg);
    assert.equal(shaped.value, "400.0000");
    // An un-shaped posting in the measured accounts refuses.
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-50.0000" },
      { account: h.org.accounts.bank, amount: "50.0000" },
    ]);
    await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, cfg), /carries no department/);
  });
});

test("project measures need the Projects feature and named projects", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const projectId = randomUUID();
    await db.execute(sql`
      insert into projects (id, org_id, name, status) values (${projectId}, ${h.org.orgId}, 'Harbour', 'active')
    `);
    const cfg = await moneyConfig(h, {
      metric: "revenue", expenseAccountIds: [], scope: "project", projectIds: [projectId],
    });
    // Projects ships enabled by default: switch it off and the engine
    // boundary refuses before any project row is read.
    await setFeatures(h.org.orgId, { projects: false });
    await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, cfg), /Projects feature/);
    await setFeatures(h.org.orgId, { projects: true });
    // Unknown projects refuse rather than measuring an empty set.
    const unknown = await moneyConfig(h, {
      metric: "revenue", expenseAccountIds: [], scope: "project", projectIds: [randomUUID()],
    });
    await refuses(() => measureMoneySource(db, h.org.orgId, h.ledgerId, unknown), /outside this organization/);
    // Shaped postings sum under the named project.
    await postEntry(h, [
      { account: h.org.accounts.revenue, amount: "-750.0000", project: projectId },
      { account: h.org.accounts.bank, amount: "750.0000", project: projectId },
    ]);
    const shaped = await measureMoneySource(db, h.org.orgId, h.ledgerId, cfg);
    assert.equal(shaped.value, "750.0000");
  });
});

test("the period basis resolves from the native fiscal calendar", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const calendar = await resolvePeriodBasis(db, h.org.orgId);
    assert.equal(calendar.basis.kind, "calendar");
    // An April-start calendar becomes an explicitly named fiscal basis.
    await db.execute(sql`
      update fiscal_calendars set year_start_month = 4, name = 'April FY'
       where org_id = ${h.org.orgId} and is_default
    `);
    const fiscal = await resolvePeriodBasis(db, h.org.orgId);
    assert.equal(fiscal.basis.kind, "fiscal");
    if (fiscal.basis.kind === "fiscal") {
      assert.equal(fiscal.basis.yearStartMonth, 4);
      assert.equal(fiscal.basis.calendarName, "April FY");
    }
    // No default is a refusal, not a silent calendar assumption.
    await db.execute(sql`update fiscal_calendars set is_default = false where org_id = ${h.org.orgId}`);
    await refuses(() => resolvePeriodBasis(db, h.org.orgId), /no default fiscal calendar/);
  });
});

function hoursConfig(h: Harness, memberIds: readonly string[], overrides: Partial<HoursSourceConfig> = {}): HoursSourceConfig {
  return {
    scope: "company",
    departmentIds: [],
    projectIds: [],
    legalEntityId: h.org.subsidiaryId,
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    memberEmploymentIds: memberIds,
    allowedSubsidiaryIds: null,
    ...overrides,
  };
}

test("approved hours total the scope and attribute per member employment", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const first = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Crew A" });
    const second = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Crew B" });
    await seedTime(h, first.workerPartyId, { hours: "24.0000" });
    await seedTime(h, second.workerPartyId, { hours: "8.0000" });
    // Draft time never enters the base.
    await seedTime(h, second.workerPartyId, { hours: "100.0000", status: "draft" });
    const snapshot = await measureApprovedHours(
      db, h.org.orgId, h.hrId,
      hoursConfig(h, [first.employmentId, second.employmentId]),
    );
    assert.equal(snapshot.totalHours, "32.0000");
    const attributed = new Map(snapshot.hoursByEmployment.map((r) => [r.employmentId, r.hours]));
    assert.equal(attributed.get(first.employmentId), "24.0000");
    assert.equal(attributed.get(second.employmentId), "8.0000");
    assert.equal(snapshot.entryCount, 2);
  });
});

test("hours attribution refuses a worker with two member employments", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const party = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${party}, ${h.org.orgId}, 'person', 'Dual Role', true, '{}'::jsonb)
    `);
    const first = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: party });
    const second = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { workerPartyId: party });
    await seedTime(h, party, { hours: "8.0000" });
    await refuses(
      () => measureApprovedHours(
        db, h.org.orgId, h.hrId, hoursConfig(h, [first.employmentId, second.employmentId]),
      ),
      /two member employments/,
    );
  });
});

test("hours attribution proves the member sits in the program entity", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const otherSub = randomUUID();
    // A second root is refused by the org-root unique: West Co hangs under
    // the harness root like a real child subsidiary.
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherSub}, ${h.org.orgId}, ${h.org.subsidiaryId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `);
    const stranger = await seedEmployment(h.org.orgId, otherSub, { displayName: "West Crew" });
    await refuses(
      () => measureApprovedHours(db, h.org.orgId, h.hrId, hoursConfig(h, [stranger.employmentId])),
      /another legal entity/,
    );
  });
});

test("negative approved hours refuse instead of netting the base", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, { displayName: "Crew A" });
    await seedTime(h, worker.workerPartyId, { hours: "-4.0000" });
    await refuses(
      () => measureApprovedHours(db, h.org.orgId, h.hrId, hoursConfig(h, [worker.employmentId])),
      /negative hours/,
    );
  });
});

test("measures never cross tenants", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    await withHarness(() => setupHarness(INCENTIVES_SPEC), async (other) => {
      const cfg = await moneyConfig(other, { revenueAccountIds: [h.org.accounts.revenue] });
      await refuses(
        () => measureMoneySource(db, other.org.orgId, other.ledgerId, cfg),
        /outside this organization/,
      );
    });
  });
});

test("granting the ledger read opens profit measures to HR", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    await grantPermissions(h.org.orgId, h.hrId, ["gl.read"]);
    const cfg = await moneyConfig(h, { metric: "revenue", expenseAccountIds: [] });
    const snapshot = await measureMoneySource(db, h.org.orgId, h.hrId, cfg);
    assert.equal(snapshot.value, "0.0000");
  });
});


test("approved-hours attribution uses worked dates inside effective membership", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const worker = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {displayName: "Midmonth member"});
    const before = await seedTime(h, worker.workerPartyId, {date: "2026-07-01", hours: "8.0000"});
    const inside = await seedTime(h, worker.workerPartyId, {date: "2026-07-15", hours: "4.0000"});
    const snapshot = await measureApprovedHours(db, h.org.orgId, h.hrId, hoursConfig(h, [worker.employmentId], {
      memberPeriods: [{employmentId: worker.employmentId, effectiveFrom: "2026-07-10", effectiveTo: "2026-07-20"}],
    }));
    assert.equal(snapshot.totalHours, "12.0000", "the company base includes all approved effort");
    assert.deepEqual(snapshot.hoursByEmployment, [{employmentId: worker.employmentId, hours: "4.0000"}]);
    assert.equal(snapshot.approvedHoursFacts.find((f) => f.entryId === before)!.employmentId, null);
    assert.equal(snapshot.approvedHoursFacts.find((f) => f.entryId === inside)!.employmentId, worker.employmentId);
    assert.equal(snapshot.approvedHoursFacts.find((f) => f.entryId === inside)!.workedOn, "2026-07-15");
  });
});


test("approved hours follow the employer active on the worked date, not old employment history", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(INCENTIVES_SPEC), async (h) => {
    const former = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {displayName: "Former employee", status: "terminated"});
    const otherEntity = await mkSecondSubsidiary(h.org.orgId, h.org.subsidiaryId, {currency: "USD", country: "US"});
    await seedEmployment(h.org.orgId, otherEntity, {workerPartyId: former.workerPartyId});
    await seedTime(h, former.workerPartyId, {hours: "8.0000"});
    const measured = await measureApprovedHours(db, h.org.orgId, h.hrId, hoursConfig(h, [former.employmentId]));
    assert.equal(measured.totalHours, "0.0000");
    assert.deepEqual(measured.approvedHoursFacts, []);
    assert.deepEqual(measured.hoursByEmployment, [{employmentId: former.employmentId, hours: "0.0000"}]);
  });
});
