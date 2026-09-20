import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-u1-P4 — the dashboard "Cash balance" tile summed asset_bank org-wide
// (inactive and summary accounts included, primary book only, stored currency
// with no translation) while the cash cockpit and forecast read bankBalances
// (per-account, is_summary=false AND is_active, subsidiary-scoped, per-leg
// spot translation). For any org with subsidiaries, an inactive/summary bank
// account, or more than one currency the tile disagreed with the cockpit —
// the mixed-currency sum is arithmetic on incommensurable units.
//
// The tile now reads bankBalances (summed), the same doorway as the cockpit
// and the forecast's startingCash. This file pins the swap: the frozen
// pre-fix reader below (verbatim engine/src/dashboard-reporting.ts at
// removal) and the tile MUST agree on a simple single-currency
// single-subsidiary org, and MUST disagree in exactly the three fixed ways
// (scope, account population, translation) on a complicated one.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    // Worktree node_modules is a symlink to the main checkout's install, so
    // bare @openbooks self-imports would resolve to MAIN-checkout code (a
    // second db pool without the test bypass). Pin them to this checkout —
    // the same modules a real install resolves — process-wide, so the
    // loader under test and its transitive engine imports agree.
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
// Fixture writes cross the maintenance boundary (withBypass); the loader
// under test runs tenant-scoped through withOrgContext — the same RLS
// posture as a production request via setRequestOrg. Both are explicit
// AsyncLocalStorage scopes, so they hold regardless of which request-org
// resolver the web import chain registered.
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { toUnits } = await import("@openbooks/engine/src/money/money.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { withSimClock: pinClock } = await import("@openbooks/engine/src/platform/clock.ts");
const { loadDashboardMetrics } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;

const DB = !!process.env.OPENBOOKS_DB_URL;
const TODAY = "2026-07-15";

function authzFor(orgId: string, userId: string, allowedSubsidiaryIds: Set<string> | null): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Cash Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(["dashboard.read", "gl.read", "ar.read", "ap.read"]),
    allowedSubsidiaryIds,
  };
}

/**
 * Frozen pre-fix dashboard cash reader — verbatim
 * engine/src/dashboard-reporting.ts at removal, kept here ONLY as the
 * counterfactual this test proves the tile no longer equals. If this copy
 * drifts from the removed file's git history, the test's "agreement" leg
 * stops meaning "no regression for simple orgs".
 */
function legacyDashboardCashQuery(orgId: string, today: string) {
  const primaryBook = sql`(select b.id from accounting_books b where b.org_id = ${orgId} and b.is_primary order by b.created_at limit 1)`;
  return sql`
    select
      (select base_currency from orgs where id = ${orgId}) as base_currency,
      (select coalesce(sum(x.amt), 0)
         from (
           select (g.debit_total - g.credit_total) as amt
             from gl_month_activity g
             join accounts a on a.id = g.account_id and a.org_id = ${orgId} and a.type = 'asset_bank'
            where g.org_id = ${orgId}
              and g.book_id = ${primaryBook}
              and g.month < date_trunc('month', ${today}::date)::date
            union all
           select l.amount as amt
             from journal_lines l
             join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
              and e.status in ('posted', 'reversed')
              and e.book_id = ${primaryBook}
              and e.posting_date >= date_trunc('month', ${today}::date)::date
              and e.posting_date <= ${today}
             join accounts a on a.id = l.account_id and a.org_id = ${orgId} and a.type = 'asset_bank'
            where l.org_id = ${orgId}
         ) x) as cash_balance
  `;
}

async function legacyCash(orgId: string): Promise<string> {
  const r = (await db.execute(legacyDashboardCashQuery(orgId, TODAY))) as unknown as {
    rows: Array<{ cash_balance: string }>;
  };
  return r.rows[0]!.cash_balance;
}

// Fixture writes run under the bypass. Importing a web reader replaces the
// test bypass with a resolver that returns undefined outside a request, so a
// bare seed here fails RLS with an error that reads like a product defect.
async function ensurePeriod(orgId: string, year: number, month: number, start: string, end: string): Promise<string> {
  const id = randomUUID();
  return withBypass(async () => {
    const cal = (await db.execute<{ fiscal_calendar_id: string }>(sql`
      select fiscal_calendar_id from accounting_periods where org_id = ${orgId} and starts_on = '2026-07-01'`)).rows[0]!.fiscal_calendar_id;
    await db.execute(sql`insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${id}, ${orgId}, ${year}, ${month}, ${`${year}-0${month}`}, ${start}, ${end}, false, ${cal})`);
    return id;
  });
}

async function postBank(
  org: ScratchOrg,
  opts: {
    book?: string; sub?: string; account?: string;
    amount: string; currency?: string; date?: string; period?: string; label: string;
  },
): Promise<void> {
  const entry = randomUUID();
  // Own maintenance transaction: postBank's journal guard must see committed
  // subsidiary/account rows, so callers stage reference seeds in an earlier
  // committed block (a nested transaction cannot see the caller's uncommitted
  // writes, and a context-only scope would escape to the pool).
  await withBypass(async () => {
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
    values (${entry}, ${org.orgId}, ${opts.book ?? org.bookId}, ${opts.sub ?? org.subsidiaryId},
      ${`CASH-${opts.label}-${entry.slice(0, 8)}`}, ${opts.date ?? org.date}, ${opts.period ?? org.periodId}, 'draft', 'manual')`);
  const amount = opts.amount;
  const currency = opts.currency ?? "CAD";
  await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
    values (${randomUUID()}, ${org.orgId}, ${entry}, 1, ${opts.account ?? org.accounts.bank}, ${opts.sub ?? org.subsidiaryId},
        ${amount}, ${currency}, ${amount}, 1),
      (${randomUUID()}, ${org.orgId}, ${entry}, 2, ${org.accounts.adjustment}, ${opts.sub ?? org.subsidiaryId},
        ${"-" + amount}, ${currency}, ${"-" + amount}, 1)`);
  await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
  });
}

test("dashboard cash tile agrees with the legacy reader on a simple org", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(() => postBank(org, { amount: "1000.0000", label: "simple" }));
    const actor = await withBypass(() => createScratchUser(org.orgId, "Cash Reader", "admin"));
    await pinClock(TODAY, async () => {
      await withOrgContext(org.orgId, async () => {
        const metrics = await loadDashboardMetrics(authzFor(org.orgId, actor, null));
        assert.equal(metrics.asOfDate, TODAY, "tile is cut at the pinned business day");
        assert.equal(metrics.baseCurrency, "CAD", "tile stays denominated in the org base");
        assert.equal(toUnits(metrics.cashBalance), toUnits("1000.0000"), "tile reads the bank balance");
        assert.equal(
          toUnits(await legacyCash(org.orgId)),
          toUnits(metrics.cashBalance),
          "simple org: new reader agrees with the old query (no regression)",
        );
      });
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("dashboard cash tile disagrees with the legacy reader correctly", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      await ensurePeriod(org.orgId, 2026, 6, "2026-06-01", "2026-06-30");
      await ensurePeriod(org.orgId, 2026, 8, "2026-08-01", "2026-08-31");
      const usSub = randomUUID();
      const usdBank = randomUUID();
      const dormantBank = randomUUID();
      const taxBook = randomUUID();
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${usSub}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US')`);
      // No summary-with-balance case is seeded: it is unreachable through any
      // legitimate path — the line trigger refuses postings to summary
      // accounts (jl_check_account) AND the account guard refuses flipping
      // is_summary once lines exist — so the tile inherits bankBalances'
      // is_summary exclusion by construction, with no divergent state to pin.
      // Dormant-with-balance IS reachable (deactivation keeps history), and
      // that is the account-population divergence seeded below.
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${usdBank}, ${org.orgId}, '1010', 'USD Cash', 'asset_bank', ${usSub}, false, true),
               (${dormantBank}, ${org.orgId}, '1020', 'Dormant CAD', 'asset_bank', ${org.subsidiaryId}, false, true)`);
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${taxBook}, ${org.orgId}, 'TAX', 'Tax', false, true, true)`);
      await db.execute(sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'USD', 'CAD', '2026-07-15'::date, 'spot', 1.35, 'manual')`);
    });
    // Postings run in a second committed block: each postBank opens its own
    // maintenance transaction, which cannot see this block's uncommitted
    // subsidiary/account rows — the journal subsidiary guard would raise.
    await withBypass(async () => {
      const june = (await db.execute<{ id: string }>(sql`select id from accounting_periods where org_id = ${org.orgId} and starts_on = '2026-06-01'`)).rows[0]!.id;
      const august = (await db.execute<{ id: string }>(sql`select id from accounting_periods where org_id = ${org.orgId} and starts_on = '2026-08-01'`)).rows[0]!.id;
      const usSub = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id = ${org.orgId} and name = 'US Co'`)).rows[0]!.id;
      const usdBank = (await db.execute<{ id: string }>(sql`select id from accounts where org_id = ${org.orgId} and number = '1010'`)).rows[0]!.id;
      const dormantBank = (await db.execute<{ id: string }>(sql`select id from accounts where org_id = ${org.orgId} and number = '1020'`)).rows[0]!.id;
      const taxBook = (await db.execute<{ id: string }>(sql`select id from accounting_books where org_id = ${org.orgId} and code = 'TAX'`)).rows[0]!.id;
      // Summary branch (June) + sliver branch (July) on the root bank.
      await postBank(org, { amount: "500.0000", date: "2026-06-20", period: june, label: "root-jun" });
      await postBank(org, { amount: "1000.0000", label: "root-jul" });
      // USD 100 (June summary branch): translated 135 CAD by the tile, added
      // raw as 100 by the legacy sum.
      await postBank(org, { sub: usSub, account: usdBank, amount: "100.0000", currency: "USD", date: "2026-06-20", period: june, label: "usd-jun" });
      // Balance stranded on a later-deactivated account: the line trigger
      // forbids posting to an inactive account directly, so post while
      // active, then deactivate — the production lifecycle (deactivation
      // keeps history). Counted by the legacy sum, excluded by the tile
      // (the cockpit never showed it).
      await postBank(org, { account: dormantBank, amount: "200.0000", label: "dormant" });
      await db.execute(sql`update accounts set is_active = false where id = ${dormantBank} and org_id = ${org.orgId}`);
      // Secondary book + future-dated line: excluded by BOTH readers (the two
      // previously-fixed scope guards must survive the swap).
      await postBank(org, { book: taxBook, amount: "700.0000", label: "taxbook" });
      await postBank(org, { amount: "900.0000", date: "2026-08-05", period: august, label: "future" });
    });
    const actor = await withBypass(() => createScratchUser(org.orgId, "Cash Reader", "admin"));
    await pinClock(TODAY, async () => {
      await withOrgContext(org.orgId, async () => {
        // 500 + 1000 + 100(USD raw) + 200: the legacy sum mixes the USD leg
        // in raw and counts the dormant account. Asserting the exact wrong
        // total pins WHAT the tile no longer equals.
        assert.equal(toUnits(await legacyCash(org.orgId)), toUnits("1800.0000"), "legacy reader sums raw mixed units plus dormant");
        const metrics = await loadDashboardMetrics(authzFor(org.orgId, actor, null));
        assert.equal(metrics.asOfDate, TODAY, "tile is cut at the pinned business day");
        // 500 + 1000 + 100×1.35: dormant/summary excluded, USD translated.
        assert.equal(toUnits(metrics.cashBalance), toUnits("1635.0000"), "tile ties the cockpit: scoped population, translated");
        const restricted = await loadDashboardMetrics(authzFor(org.orgId, actor, new Set([org.subsidiaryId])));
        // The USD leg sits outside the caller's subsidiary view: same figure
        // the /banking cockpit shows that caller.
        assert.equal(toUnits(restricted.cashBalance), toUnits("1500.0000"), "tile honors the caller subsidiary scope");
      });
    });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
