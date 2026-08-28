import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { Client } from "pg";

// Live-Postgres regression for fiscal-calendar changes in the setup wizard.
// The canonical period index is shared by every organization, so a tenant's
// setup must stage only its own rows while leaving the index available to
// unrelated tenants. The tests exercise the real route transaction and use
// only the authorization seam as a test double.
const stateKey = Symbol.for("openbooks.setup-wizard-route-test");
interface Authz {
  user: { orgId: string; id: string };
  permissions: Set<string>;
  allowedSubsidiaryIds: null;
}
const routeState: {
  authz: Authz | null;
  authzQueue: Authz[];
} = { authz: null, authzQueue: [] };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.setup-wizard-route-test')]
  export async function guardPermission(_permission) {
    const authz = state.authzQueue.shift() ?? state.authz
    if (!authz) return new Response(null, { status: 403 })
    return authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(
        new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href,
        context,
      );
    }
    if (
      specifier === "../../../../../lib/authz"
      && context.parentURL?.includes("setup/wizard")
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?period-staging-regression-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/db.ts"
);
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;
const ADVISORY_CLASS = 21470;
const ADVISORY_OBJECT = 4242;

interface Fixture {
  orgId: string;
  actorId: string;
  periodId: string;
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Setup Admin", "admin");
  await withBypassContext(() =>
    db.execute(sql`
      update orgs
         set settings = settings || ${JSON.stringify({
           industry: "general_business",
           reportingFramework: "ifrs",
           taxFramework: "ias12",
           fiscalYearStartMonth: 1,
         })}::jsonb
       where id = ${org.orgId}`),
  );
  return { orgId: org.orgId, actorId, periodId: org.periodId };
}

function authorize(fixture: Fixture): Authz {
  return {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function putRequest(fiscalYearStartMonth: number): Request {
  return new Request("http://localhost/api/admin/setup/wizard", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Scratch Company",
      country: "CA",
      baseCurrency: "CAD",
      fiscalYearStartMonth,
      industry: "general_business",
      features: {},
      workspaceProfile: {
        teamSize: "solo",
        complexity: "essentials",
        bookStart: "fresh",
        taxPosition: "unsure",
        monthlyActivity: "light",
        closeCadence: "monthly",
      },
    }),
  });
}

function put(fixture: Fixture, fiscalYearStartMonth: number): Promise<Response> {
  return withOrgContext(fixture.orgId, () =>
    PUT(putRequest(fiscalYearStartMonth)),
  );
}

async function ensureCanonicalIndex(): Promise<void> {
  await withBypassContext(() =>
    db.execute(sql`
      create unique index if not exists periods_org_year_num
        on accounting_periods (org_id, fiscal_year, period_number)`),
  );
}

async function periodState(fixture: Fixture): Promise<{
  fiscalYear: number;
  periodNumber: number;
  name: string;
  calendarMonth: number;
}> {
  const result = await withBypassContext(() =>
    db.execute<{
      fiscalYear: number;
      periodNumber: number;
      name: string;
      calendarMonth: number;
    }>(sql`
      select p.fiscal_year as "fiscalYear",
             p.period_number as "periodNumber",
             p.name,
             c.year_start_month as "calendarMonth"
        from accounting_periods p
        join fiscal_calendars c on c.id = p.fiscal_calendar_id
       where p.id = ${fixture.periodId}`),
  );
  assert.ok(result.rows[0], "scratch period exists");
  return result.rows[0]!;
}

async function canonicalIndexExists(): Promise<boolean> {
  const result = await withBypassContext(() =>
    db.execute<{ name: string | null }>(sql`
      select to_regclass('public.periods_org_year_num') as name`),
  );
  return result.rows[0]?.name === "periods_org_year_num";
}

async function installStagingPause(orgId: string): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `wizard_period_pause_${suffix}`;
  const triggerName = `wizard_period_pause_trigger_${suffix}`;
  await withBypassContext(() =>
    db.execute(sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.org_id = '${orgId}'::uuid and new.period_number < 0 then
          perform pg_advisory_xact_lock(${ADVISORY_CLASS}, ${ADVISORY_OBJECT});
          perform pg_sleep(3);
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before update of period_number on accounting_periods
        for each row execute function public."${functionName}"();
    `)),
  );
  return async () => {
    await withBypassContext(() =>
      db.execute(sql.raw(`
        drop trigger if exists "${triggerName}" on accounting_periods;
        drop function if exists public."${functionName}"();
      `)),
    );
  };
}

async function waitForStagingPause(client: Client): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ held: boolean }>(`
      select exists (
        select 1 from pg_locks
         where locktype = 'advisory'
           and classid = ${ADVISORY_CLASS}
           and objid = ${ADVISORY_OBJECT}
           and granted
      ) as held`);
    if (result.rows[0]?.held) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fiscal-period staging pause was not reached");
}

async function installAuditFailure(actorId: string): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `wizard_audit_failure_${suffix}`;
  const triggerName = `wizard_audit_failure_trigger_${suffix}`;
  await withBypassContext(() =>
    db.execute(sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.table_name = 'orgs' and new.actor_id = '${actorId}'::uuid then
          raise exception 'forced wizard audit failure';
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function public."${functionName}"();
    `)),
  );
  return async () => {
    await withBypassContext(() =>
      db.execute(sql.raw(`
        drop trigger if exists "${triggerName}" on audit_log;
        drop function if exists public."${functionName}"();
      `)),
    );
  };
}

function postgresCauseMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause;
  return String(cause?.message ?? "");
}

test(
  "concurrent tenant setup stages only its own periods under the shared index",
  { skip: !DB },
  async () => {
    await ensureCanonicalIndex();
    const first = await seed();
    const second = await seed();
    let removePause: (() => Promise<void>) | undefined;
    const observer = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
    let observerOpen = false;
    try {
      removePause = await installStagingPause(first.orgId);
      await observer.connect();
      observerOpen = true;
      await observer.query("set statement_timeout = '1000ms'");

      routeState.authz = null;
      routeState.authzQueue = [authorize(first), authorize(second)];
      const firstWrite = put(first, 4);
      const secondWrite = put(second, 4);
      await waitForStagingPause(observer);

      // A global DROP INDEX would hold catalog locks here and hide the index
      // from an unrelated observer. Staging must leave both the index and the
      // other tenant's canonical period available while org A is paused.
      const observed = await observer.query<{
        indexName: string | null;
        otherPeriodNumber: number;
      }>(`
        select to_regclass('public.periods_org_year_num') as "indexName",
               (select period_number from accounting_periods where id = '${second.periodId}') as "otherPeriodNumber"`);
      assert.equal(observed.rows[0]?.indexName, "periods_org_year_num");
      assert.ok(
        Number.isInteger(observed.rows[0]?.otherPeriodNumber)
        && observed.rows[0]!.otherPeriodNumber > 0,
        "the unrelated tenant remains in the canonical period range",
      );

      const secondResult = await Promise.race([
        secondWrite.then(() => "completed" as const),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 1_500)),
      ]);
      assert.equal(secondResult, "completed");

      const responses = await Promise.all([firstWrite, secondWrite]);
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      assert.equal(await canonicalIndexExists(), true);
      assert.deepEqual(await periodState(first), {
        fiscalYear: 2027,
        periodNumber: 4,
        name: "Jul 2026",
        calendarMonth: 4,
      });
      assert.deepEqual(await periodState(second), {
        fiscalYear: 2027,
        periodNumber: 4,
        name: "Jul 2026",
        calendarMonth: 4,
      });
    } finally {
      routeState.authz = null;
      routeState.authzQueue = [];
      if (observerOpen) await observer.end().catch(() => {});
      await removePause?.();
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);

test(
  "fiscal setup rollback leaves the canonical index and period labels intact",
  { skip: !DB },
  async () => {
    await ensureCanonicalIndex();
    const fixture = await seed();
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      routeState.authz = authorize(fixture);
      const before = await periodState(fixture);
      removeFailure = await installAuditFailure(fixture.actorId);

      await assert.rejects(
        () => put(fixture, 4),
        (error: unknown) => postgresCauseMessage(error).includes("forced wizard audit failure"),
      );

      assert.equal(await canonicalIndexExists(), true);
      assert.deepEqual(await periodState(fixture), before);
    } finally {
      routeState.authz = null;
      routeState.authzQueue = [];
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "accounting-foundation probe re-runs after the wizard waits for the org lock",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Foundation Admin", "admin");
    const entryId = randomUUID();
    const holder = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
    const evidence = new Client({ connectionString: process.env.OPENBOOKS_DB_URL });
    let holderOpen = false;
    let evidenceOpen = false;
    try {
      await withBypassContext(() => db.execute(sql`
        insert into currencies (code, name, minor_units)
        values ('USD', 'US Dollar', 2)
        on conflict (code) do nothing`));
      await withBypassContext(() => db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
                'WIZARD-RACE', ${org.date}, ${org.periodId},
                'wizard race evidence', 'draft', 'manual')`));

      routeState.authz = authorize({ orgId: org.orgId, actorId, periodId: org.periodId });
      routeState.authzQueue = [];
      await holder.connect();
      holderOpen = true;
      await holder.query("begin");
      await holder.query(
        "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
        [org.orgId],
      );
      await holder.query("select id from orgs where id = $1 for update", [org.orgId]);

      const wizard = withOrgContext(org.orgId, () =>
        PUT(new Request("http://localhost/api/admin/setup/wizard", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Scratch Company",
            country: "CA",
            baseCurrency: "USD",
            fiscalYearStartMonth: 1,
            industry: "professional_services",
            features: {},
            workspaceProfile: {
              teamSize: "solo",
              complexity: "essentials",
              bookStart: "fresh",
              taxPosition: "unsure",
              monthlyActivity: "light",
              closeCadence: "monthly",
            },
          }),
        })),
      );
      const deadline = Date.now() + 15_000;
      let wizardWaiting = false;
      while (Date.now() < deadline) {
        const waiting = await db.execute<{ count: number }>(sql`
          select count(*)::int as count
            from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and wait_event_type = 'Lock'
             and query ilike '%from orgs%'`);
        if ((waiting.rows[0]?.count ?? 0) > 0) {
          wizardWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(wizardWaiting, true, "setup wizard did not park on the organization row lock");

      await evidence.connect();
      evidenceOpen = true;
      await evidence.query("begin");
      await evidence.query(
        "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'on', true)",
        [org.orgId],
      );
      await evidence.query(
        `insert into journal_lines
           (org_id, entry_id, line_number, account_id, subsidiary_id,
            amount, currency, txn_amount, fx_rate)
         values ($1, $2, 1, $3, $4, '1', 'CAD', '1', '1'),
                ($1, $2, 2, $3, $4, '-1', 'CAD', '-1', '1')`,
        [org.orgId, entryId, org.accounts.bank, org.subsidiaryId],
      );
      await evidence.query("commit");
      await evidence.end();
      evidenceOpen = false;
      await holder.query("commit");
      await holder.end();
      holderOpen = false;

      const response = await wizard;
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "base-currency-locked",
        message: "Cannot change base currency after postings exist.",
      });
      const after = await withBypassContext(() => db.execute<{ base_currency: string }>(sql`
        select base_currency from orgs where id = ${org.orgId}`));
      assert.equal(after.rows[0]?.base_currency, "CAD");
    } finally {
      routeState.authz = null;
      routeState.authzQueue = [];
      if (evidenceOpen) {
        await evidence.query("rollback").catch(() => {});
        await evidence.end().catch(() => {});
      }
      if (holderOpen) {
        await holder.query("rollback").catch(() => {});
        await holder.end().catch(() => {});
      }
      await dropScratchOrg(org.orgId);
    }
  },
);
