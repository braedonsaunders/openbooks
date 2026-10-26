import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { verifySampleOperatingHistory } from "./readiness.ts";
import { cmp, fromUnits, toUnits } from "../money/money.ts";
import { installEngineSeams } from "../composition/install.ts";
import { db, withOrgContext, withBypass } from "../platform/db.ts";
import { provisionOrg } from "../sim/world.ts";
import { getProfile } from "../sim/profiles/index.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import {
  DEMO_DATA_VERSION,
  installDemoScenarios,
  verifyDemoScenarios,
} from "./install-scenarios.ts";
import { SampleLocalAuthorRequiredError } from "./operator.ts";
import { demoRecordId } from "./scenarios.ts";
import { retireSampleFixtureCompanies } from "./retirement-test-fixtures.ts";
import { buildCapTable, holdingState } from "../equity/cap-table.ts";
import { loadEquityBook } from "../equity/store.ts";
import { businessToday } from "../platform/business-date.ts";
import { addMonthsClamped, endOfMonth } from "../platform/civil-date.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
installEngineSeams();

async function cleanupInstalledWorld(orgId: string): Promise<void> {
  const anchor = await withBypass(() => createScratchOrg());
  // The native helper creates an active local recovery actor in this retained
  // company. Keep both available if admission or target cleanup refuses.
  await retireSampleFixtureCompanies(anchor.orgId, [orgId]);
  await withBypass(() => dropScratchOrg(anchor.orgId));
}

for (const profile of SAMPLE_COMPANY_PROFILES)
  test(
    `${profile.companyName}: native demo installation is complete, balanced, and idempotent`,
    enabled,
    async () => {
      const world = await provisionOrg(getProfile(profile.profileId), {
        startDate: "2026-01-01",
        endDate: "2027-12-31",
      });
      let platformHomeOrgId: string | undefined;
      let actorOptions: { actorId?: string } = {};
      try {
        if (profile.industryKey === "engineering_architecture") {
          const home = await withBypass(() => createScratchOrg());
          platformHomeOrgId = home.orgId;
          const actorId = await withBypass(() =>
            createScratchUser(home.orgId, "Explicit engineering operator", "operator"),
          );
          await withBypass(() =>
            db.execute(
              sql`update users set is_super_admin=true where org_id=${home.orgId} and id=${actorId}`,
            ),
          );
          actorOptions = { actorId };
        }
        if (
          [
            "construction_contractor",
            "general_business",
            "nonprofit",
            "healthcare_practice",
            "it_software_saas",
            "field_service",
          ].includes(profile.industryKey)
        ) {
          const home = await withBypass(() => createScratchOrg());
          try {
            const foreignActor = await withBypass(() =>
              createScratchUser(home.orgId, "Explicit platform author", "operator"),
            );
            await withBypass(() =>
              db.execute(
                sql`update users set is_super_admin=true where org_id=${home.orgId} and id=${foreignActor}`,
              ),
            );
            const unchanged = () =>
              withOrgContext(
                world.orgId,
                async () =>
                  await db.execute(
                    sql`
          select settings,(select count(*)::int from documents where org_id=${world.orgId}) as documents,
            (select count(*)::int from audit_log where org_id=${world.orgId}) as audits,
            (select count(*)::int from field_ticket_labor_snapshots where org_id=${world.orgId}) as labor_snapshots
          from orgs where id=${world.orgId}`,
                    "objects",
                  ),
              );
            const beforeRefusal = await unchanged();
            await assert.rejects(
              installDemoScenarios(world.orgId, profile.industryKey, { actorId: foreignActor }),
              (error: unknown) =>
                error instanceof SampleLocalAuthorRequiredError &&
                error.industryKey === profile.industryKey,
            );
            assert.deepEqual(
              await unchanged(),
              beforeRefusal,
              "a foreign platform author refuses before configuration, document or audit writes",
            );
          } finally {
            await withBypass(() => dropScratchOrg(home.orgId));
          }
        }
        if (profile.industryKey === "general_business")
          await withOrgContext(world.orgId, async () => {
            const appId = demoRecordId(world.orgId, "apps", "main");
            await db.execute(
              sql`insert into apps(id,org_id,key,name,status,created_by,updated_by) values (${appId},${world.orgId},'demo-operations','Operations extension example','disabled',${world.actors.admin},${world.actors.admin})`,
            );
            await db.execute(
              sql`insert into app_versions(id,org_id,app_id,version,manifest,status,created_by,updated_by) values (${demoRecordId(world.orgId, "app_versions", "main")},${world.orgId},${appId},'1.0.0','{"name":"Earlier demonstration"}'::jsonb,'draft',${world.actors.admin},${world.actors.admin})`,
            );
          });
        const result = await installDemoScenarios(world.orgId, profile.industryKey, actorOptions);
        assert.equal(result.version, DEMO_DATA_VERSION);
        assert.ok(result.inserted > 20);
        const verified = await verifyDemoScenarios(world.orgId, profile.industryKey);
        assert.deepEqual(verified.missing, []);
        assert.equal(verified.ready, true);
        assert.deepEqual(
          await withOrgContext(world.orgId, () =>
            verifySampleOperatingHistory(world.orgId, profile.industryKey),
          ),
          [],
          "each industry meets posted volume, counterparties, months and settlement diversity",
        );
        if (profile.industryKey === "general_business")
          await withOrgContext(world.orgId, async () => {
            const versions = await db.execute<{
              version: string;
              manifest: Record<string, unknown>;
            }>(
              sql`select version,manifest from app_versions where org_id=${world.orgId} and app_id=${demoRecordId(world.orgId, "apps", "main")} order by version`,
              "objects",
            );
            assert.equal(versions.length, 2, "package corrections append a new immutable revision");
            assert.deepEqual(versions[0]!.manifest, { name: "Earlier demonstration" });
            assert.equal(versions[1]!.version, "1.0.1");
          });
        if (profile.industryKey === "construction_contractor")
          await withOrgContext(world.orgId, async () => {
            const snapshots = (
              await db.execute<{ snapshots: number; foreign_authors: number }>(
                sql`
        select count(*)::int as snapshots,count(*) filter(where u.id is null or
          (s.superseded_by is not null and not exists(select 1 from users prior where prior.org_id=s.org_id and prior.id=s.superseded_by)))::int as foreign_authors
        from field_ticket_labor_snapshots s left join users u on u.org_id=s.org_id and u.id=s.captured_by
        where s.org_id=${world.orgId}`,
                "objects",
              )
            )[0]!;
            assert.ok(
              snapshots.snapshots >= 3,
              "construction executes the native capture workflow for its site tickets",
            );
            assert.equal(
              snapshots.foreign_authors,
              0,
              "captured and superseded labor evidence keeps tenant-local authors",
            );
          });
        const snapshot = () =>
          withOrgContext(
            world.orgId,
            async () =>
              (
                await db.execute(
                  sql`
      select (select count(*)::int from audit_log where org_id=${world.orgId}) as audits,
             (select count(*)::int from journal_entries where org_id=${world.orgId}) as entries,
             (select count(*)::int from documents where org_id=${world.orgId}) as documents
    `,
                  "objects",
                )
              )[0],
          );
        if (profile.industryKey === "it_software_saas") await assertNorthstarCapTable(world.orgId);
        const before = await snapshot();
        assert.ok(before, "installation snapshot must return its counts");
        assert.equal((await installDemoScenarios(world.orgId, profile.industryKey)).inserted, 0);
        assert.deepEqual(
          await snapshot(),
          before,
          "a retry must neither post again nor claim another material change",
        );
        if (profile.industryKey === "it_software_saas") {
          // A full reinstallation replays every cap table command by its recorded identity: nothing is issued or posted twice.
          const equity = () =>
            withOrgContext(
              world.orgId,
              async () =>
                (
                  await db.execute(
                    sql`
        select (select count(*)::int from equity_securities where org_id=${world.orgId}) as securities,
               (select count(*)::int from equity_security_events where org_id=${world.orgId}) as events,
               (select count(*)::int from equity_compensation_runs where org_id=${world.orgId}) as runs,
               (select count(*)::int from journal_entries where org_id=${world.orgId} and origin='equity') as journals
      `,
                    "objects",
                  )
                )[0],
            );
          const recorded = await equity();
          await withOrgContext(world.orgId, () =>
            db.execute(
              sql`update orgs set settings=jsonb_set(settings,'{features,equity}','false'::jsonb) where id=${world.orgId}`,
            ),
          );
          assert.equal((await verifyDemoScenarios(world.orgId, profile.industryKey)).ready, false);
          await installDemoScenarios(world.orgId, profile.industryKey);
          assert.deepEqual(
            await equity(),
            recorded,
            "the cap table history replays without a second issuance, event, run or journal",
          );
          assert.equal((await verifyDemoScenarios(world.orgId, profile.industryKey)).ready, true);
        }
        if (profile.industryKey === "general_business") {
          await withOrgContext(world.orgId, async () => {
            await db.execute(
              sql`update orgs set env_kind='sandbox', settings=jsonb_set(settings,'{features,crm}','false'::jsonb) where id=${world.orgId}`,
            );
          });
          const drifted = await verifyDemoScenarios(world.orgId, profile.industryKey);
          assert.equal(drifted.ready, false);
          assert.ok(drifted.missing.includes("authoritative industry feature settings"));
          assert.ok(drifted.missing.includes("preview environment protections"));
          await installDemoScenarios(world.orgId, profile.industryKey);
          assert.equal((await verifyDemoScenarios(world.orgId, profile.industryKey)).ready, true);
          const repaired = await snapshot();
          assert.ok(repaired, "configuration repair snapshot must return its counts");
          assert.equal(
            repaired.entries,
            before.entries,
            "configuration repair must not duplicate posting",
          );
          assert.equal(repaired.documents, before.documents);
          assert.equal(
            repaired.audits,
            Number(before.audits) + 1,
            "configuration repair records its material change",
          );
        }
        await withOrgContext(world.orgId, async () => {
          const unbalanced = await db.execute(
            sql`select entry_id from journal_lines where org_id=${world.orgId} group by entry_id having sum(amount) <> 0`,
            "objects",
          );
          assert.equal(unbalanced.length, 0, "every posted example must remain balanced");
          const refunds = await db.execute<{
            id: string;
            detail: string;
            expense: string;
            liability: string;
          }>(
            sql`
        select d.id,
          (select sum(amount)::text from document_lines where org_id=d.org_id and document_id=d.id) as detail,
          (select sum(l.amount)::text from journal_lines l join accounts a on a.org_id=l.org_id and a.id=l.account_id
            where l.org_id=d.org_id and l.entry_id=d.posted_entry_id and a.type in ('expense','cogs')) as expense,
          (select sum(l.amount)::text from journal_lines l join payment_cards c on c.org_id=l.org_id and c.liability_account_id=l.account_id
            where l.org_id=d.org_id and l.entry_id=d.posted_entry_id and c.id=d.payment_card_id) as liability
        from documents d where d.org_id=${world.orgId} and d.kind='card_refund' and d.status='posted' and d.external_source='industry_demo'
      `,
            "objects",
          );
          assert.equal(refunds.length, 2, "two native card refunds must be posted");
          for (const refund of refunds) {
            assert.equal(cmp(refund.detail, "0"), -1, "refund detail is stored negative");
            assert.equal(cmp(refund.expense, "0"), -1, "refund reverses expense");
            assert.equal(cmp(refund.liability, "0"), 1, "refund reduces the card payable");
          }
          const cash = (
            await db.execute<{ amount: string }>(
              sql`select coalesce(sum(amount),0)::text as amount from journal_lines where org_id=${world.orgId} and account_id=${demoRecordId(world.orgId, "accounts", "bank")}`,
              "objects",
            )
          )[0]!;
          assert.equal(
            cmp(cash.amount, "99500.00"),
            0,
            "bank statement balances must agree with the demonstration ledger",
          );
          await db.execute(sql`delete from hrm_goals where org_id=${world.orgId}`);
        });
        if (verified.features.hrmPerformance)
          assert.equal(
            (await verifyDemoScenarios(world.orgId, profile.industryKey)).ready,
            false,
            "metadata alone must never hide missing feature data",
          );
      } finally {
        await cleanupInstalledWorld(world.orgId);
        if (platformHomeOrgId) await withBypass(() => dropScratchOrg(platformHomeOrgId!));
      }
    },
  );

test("installer refuses an ordinary tenant before writing demo records", enabled, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await assert.rejects(
      installDemoScenarios(org.orgId, "general_business"),
      /matching synthetic master or a fully provisioned native exploration company/,
    );
    await withOrgContext(org.orgId, async () => {
      assert.equal(
        (
          await db.execute(
            sql`select id from parties where org_id=${org.orgId} and id=${demoRecordId(org.orgId, "parties", "employee")}`,
            "objects",
          )
        ).length,
        0,
      );
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test(
  "a refused scenario installation rolls back earlier records, settings, and postings",
  enabled,
  async () => {
    const world = await provisionOrg(getProfile("general-business"), {
      startDate: "2026-01-01",
      endDate: "2027-12-31",
    });
    try {
      await withOrgContext(world.orgId, () =>
        db.execute(
          sql`insert into accounts(org_id,number,name,type) values (${world.orgId},'1098','Existing operating bank','asset_bank')`,
        ),
      );
      await assert.rejects(
        installDemoScenarios(world.orgId, "general_business"),
        (error: unknown) => {
          assert.equal((error as { cause?: { code?: string } }).cause?.code, "23505");
          return true;
        },
      );
      await withOrgContext(world.orgId, async () => {
        const result = await db.execute(
          sql`
        select (select count(*)::int from accounts where org_id=${world.orgId} and id=${demoRecordId(world.orgId, "accounts", "capital")}) as capital,
               (select count(*)::int from documents where org_id=${world.orgId} and idempotency_key like 'industry-demo:%') as posted,
               (select count(*)::int from audit_log where org_id=${world.orgId} and changes->>'source'='industry_demo_installation') as audits,
               settings ? 'demoData' as registered from orgs where id=${world.orgId}
      `,
          "objects",
        );
        assert.deepEqual(result[0], { capital: 0, posted: 0, audits: 0, registered: false });
      });
    } finally {
      await cleanupInstalledWorld(world.orgId);
    }
  },
);

test("demo preparation extends fully closed history without reopening it", enabled, async () => {
  const world = await provisionOrg(getProfile("general-business"), {
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  });
  try {
    await withOrgContext(world.orgId, () =>
      db.execute(sql`
      insert into period_locks(org_id,period_id,book_id,module,state,reason)
      select p.org_id,p.id,b.id,'gl','closed','Completed prior demonstration year'
      from accounting_periods p join accounting_books b on b.org_id=p.org_id and b.is_primary where p.org_id=${world.orgId}
    `),
    );
    await installDemoScenarios(world.orgId, "general_business");
    await withOrgContext(world.orgId, async () => {
      const old = (
        await db.execute<{ total: number; closed: number }>(
          sql`
        select count(*)::int as total, count(*) filter(where lock.state='closed')::int as closed
        from accounting_periods p join period_locks lock on lock.period_id=p.id and lock.org_id=p.org_id
        where p.org_id=${world.orgId} and p.fiscal_year=2026 and lock.module='gl'
      `,
          "objects",
        )
      )[0]!;
      assert.equal(old.total, 12);
      assert.equal(old.closed, old.total);
      assert.equal(
        (
          await db.execute(
            sql`select 1 from accounting_periods where org_id=${world.orgId} and fiscal_year=2027`,
            "objects",
          )
        ).length,
        12,
      );
      const future = await db.execute(
        sql`select 1 from documents where org_id=${world.orgId} and idempotency_key in (${`industry-demo:${world.orgId}:opening-cash`},${`industry-demo:${world.orgId}:bank-charge`}) and document_date >= '2027-01-01' and status='posted'`,
        "objects",
      );
      assert.equal(future.length, 2);
    });
  } finally {
    await cleanupInstalledWorld(world.orgId);
  }
});

/** The Northstar Cloud cap table: three years of financing, awards and runs, recorded natively and balanced on the ledger. */
async function assertNorthstarCapTable(orgId: string): Promise<void> {
  const today = await businessToday(orgId);
  const year = Number(today.slice(0, 4));
  await withOrgContext(orgId, async () => {
    const subsidiaryId = (
      await db.execute<{ id: string }>(
        sql`select id from subsidiaries where org_id=${orgId} and parent_id is null`,
        "objects",
      )
    )[0]!.id;
    const counts = (
      await db.execute<Record<string, number>>(
        sql`
      select (select count(*)::int from equity_share_classes where org_id=${orgId}) as classes,
             (select count(*)::int from equity_class_amendments where org_id=${orgId}) as amendments,
             (select count(*)::int from equity_plans where org_id=${orgId}) as plans,
             (select count(*)::int from equity_plan_reserve_changes where org_id=${orgId}) as "reserveChanges",
             (select count(*)::int from equity_financing_rounds where org_id=${orgId}) as rounds,
             (select count(*)::int from equity_account_policies where org_id=${orgId}) as policies,
             (select count(*)::int from equity_securities where org_id=${orgId} and kind='option') as options,
             (select count(*)::int from equity_securities where org_id=${orgId} and kind='rsu') as rsus,
             (select count(*)::int from equity_securities where org_id=${orgId} and kind in ('safe','note')) as convertibles,
             (select count(*)::int from equity_securities where org_id=${orgId} and kind='warrant') as warrants,
             (select count(*)::int from equity_securities where org_id=${orgId} and kind='share') as certificates,
             (select count(*)::int from equity_security_amendments where org_id=${orgId}) as "mfnElections",
             (select count(*)::int from equity_interest_runs where org_id=${orgId}) as "interestRuns",
             (select count(*)::int from equity_position_movements where org_id=${orgId}) > 0 as positions
    `,
        "objects",
      )
    )[0]!;
    assert.deepEqual(
      counts,
      {
        classes: 3,
        amendments: 1,
        plans: 1,
        reserveChanges: 2,
        rounds: 2,
        policies: 2,
        options: 13,
        rsus: 2,
        convertibles: 3,
        warrants: 1,
        certificates: 11,
        mfnElections: 1,
        interestRuns: 5,
        positions: true,
      },
      "founders, round investors, conversions and exercises each hold a certificate; every award and instrument is recorded once",
    );
    const events = await db.execute<{ kind: string; n: number }>(
      sql`select kind, count(*)::int as n from equity_security_events where org_id=${orgId} group by kind order by kind`,
      "objects",
    );
    assert.deepEqual(Object.fromEntries(events.map((row) => [row.kind, row.n])), {
      convert: 3,
      election_83b: 3,
      exercise: 2,
      expire: 1,
      forfeit: 2,
      reverse: 1,
    });

    // Every month-end from the first grant through the business day carries a stock compensation run.
    let expectedRuns = 0;
    for (
      let monthEnd = `${year - 3}-07-31`;
      monthEnd <= today;
      monthEnd = endOfMonth(addMonthsClamped(`${monthEnd.slice(0, 7)}-01`, 1))
    )
      expectedRuns++;
    const runs = await db.execute<{
      through_date: string;
      total_amount: string;
      journal_entry_id: string | null;
    }>(
      sql`
      select through_date::text as through_date, total_amount::text as total_amount, journal_entry_id from equity_compensation_runs where org_id=${orgId} order by through_date`,
      "objects",
    );
    assert.equal(runs.length, expectedRuns);
    assert.ok(
      runs.every((run) => run.journal_entry_id !== null),
      "every monthly run recognizes cost through the ledger",
    );

    // The years before the operating ledger carry the equity history and are closed once it is recorded.
    const history = (
      await db.execute<{ periods: number; open: number }>(
        sql`
      select count(*)::int as periods, count(*) filter (where not exists (select 1 from period_locks l where l.org_id=p.org_id and l.period_id=p.id and l.module='gl' and l.state='closed'))::int as open
        from accounting_periods p where p.org_id=${orgId} and p.fiscal_year between ${year - 3} and ${year - 1}`,
        "objects",
      )
    )[0]!;
    assert.ok(history.periods >= 36);
    assert.equal(
      history.open,
      0,
      "the pre-operating years are closed after their history is posted",
    );

    // Equity journals balance, and the ledger agrees with the cap table's money.
    const unbalanced = await db.execute(
      sql`
      select e.id from journal_entries e join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
       where e.org_id=${orgId} and e.origin='equity' group by e.id having sum(l.amount) <> 0`,
      "objects",
    );
    assert.equal(unbalanced.length, 0, "every equity journal balances");
    const balance = async (key: string) =>
      (
        await db.execute<{ amount: string }>(
          sql`
      select coalesce(sum(amount),0)::text as amount from journal_lines where org_id=${orgId} and account_id=${demoRecordId(orgId, "accounts", key)}`,
          "objects",
        )
      )[0]!.amount;
    // Founders 810, SAFEs 1,250,000, note 500,000, Series Seed 3,600,000, Series A 14,000,000, exercises 34,560 + 3,000.
    assert.equal(
      cmp(await balance("financing-bank"), "19388370.00"),
      0,
      "the financing account holds every cash consideration",
    );
    assert.equal(
      cmp(await balance("convertible-instruments"), "0"),
      0,
      "the SAFEs and the note are relieved on conversion",
    );
    assert.equal(
      cmp(await balance("accrued-note-interest"), "0"),
      0,
      "the note's accrued interest converts with its principal",
    );
    assert.equal(
      cmp(await balance("note-interest"), "0"),
      1,
      "note interest is expensed through the interest runs and the conversion",
    );
    const recognized = runs.reduce((sum, run) => sum + toUnits(run.total_amount), 0n);
    const expense = toUnits(await balance("stock-compensation"));
    assert.equal(
      expense,
      recognized,
      "stock compensation expense is exactly what the runs recognized",
    );

    const book = await loadEquityBook(db, orgId, subsidiaryId);
    const table = buildCapTable(book, today);
    const classes = Object.fromEntries(table.classes.map((row) => [row.code, row]));
    assert.equal(classes.SERIESA!.outstanding, "4375000");
    assert.ok(
      BigInt(classes.SEED!.outstanding) > 5_000_000n,
      "the Series Seed carries its new money and the converted SAFEs and note",
    );
    assert.equal(classes.CS!.authorized, "30000000");
    assert.ok(table.convertibles.every((row) => row.status === "converted"));
    const holder = (key: string) =>
      table.holders.find((row) => row.holderPartyId === demoRecordId(orgId, "parties", key));
    assert.equal(holder("founder-1")?.sharesByClass[classes.CS!.shareClassId], "4500000");
    const option = (key: string) =>
      table.holdings.find(
        (row) => row.kind === "option" && row.holderPartyId === demoRecordId(orgId, "parties", key),
      );
    assert.equal(
      option("equity-holder-liam")?.outstanding,
      "0",
      "the departed employee's options were forfeited and expired",
    );
    assert.equal(
      option("equity-holder-sofia")?.outstanding,
      "144000",
      "the reversed forfeiture restores every unit",
    );

    // The early-exercise deposit still on the ledger is exactly the unvested restricted shares at cost as of the latest run.
    const certificate = book.securities.find(
      (security) =>
        security.kind === "share" &&
        security.holderPartyId === demoRecordId(orgId, "parties", "equity-holder-maya"),
    )!;
    const unvested = holdingState(book, certificate, runs.at(-1)!.through_date).unvested;
    assert.equal(
      cmp(await balance("early-exercise-deposits"), fromUnits(-(unvested * toUnits("0.12")))),
      0,
    );
  });
}
