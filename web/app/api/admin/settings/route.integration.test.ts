import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { Client } from "pg";

// Real-route, live-PostgreSQL regression for the company accounting-policy
// boundary. Authorization is the only mocked dependency: mutations, row locks,
// audit rollback, period/calendar updates, and account validation all execute
// through the production handler and database implementation.
const stateKey = Symbol.for("openbooks.settings-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  requestedPermissions: string[];
  deny(permission: string | null): NextResponse;
}
const routeState: RouteState = {
  authz: null,
  requestedPermissions: [],
  deny(permission) {
    return permission
      ? NextResponse.json(
          { error: `missing permission: ${permission}` },
          { status: 403 },
        )
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.settings-route-test')]
  export async function guardPermission(permission) {
    state.requestedPermissions.push(permission)
    if (!state.authz) return state.deny(null)
    if (!state.authz.permissions.has('*') && !state.authz.permissions.has(permission)) {
      return state.deny(permission)
    }
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (
      specifier === "../../../../lib/authz" &&
      context.parentURL?.includes("admin/settings")
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(
        new URL(".", context.parentURL).href,
      );
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts")
          .href,
        context,
      );
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

const routeUrl = "./route.ts?accounting-policy-boundary-test";
const { GET, PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/src/test-fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  accounts: Record<string, string>;
  bookId: string;
  subsidiaryId: string;
  periodId: string;
  date: string;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(
      org.orgId,
      "Settings Admin",
      "settings_admin",
    );
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2)
      on conflict (code) do nothing`);
    return { ...org, actorId };
  });
}

function authorize(
  fixture: Fixture,
  permissions = ["admin.setup.manage"],
): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
  routeState.requestedPermissions = [];
}

function request(body: unknown): Request {
  return new Request("http://openbooks.test/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function put(fixture: Fixture, body: unknown): Promise<Response> {
  return withOrgContext(fixture.orgId, () => PUT(request(body)));
}

async function settingsState(orgId: string): Promise<{
  name: string;
  baseCurrency: string;
  settings: Record<string, unknown>;
  calendarMonth: number;
  periods: { fiscalYear: number; periodNumber: number; name: string }[];
  audits: number;
}> {
  return withOrgContext(orgId, async () => {
    const row = await db.execute<{
      name: string;
      baseCurrency: string;
      settings: Record<string, unknown>;
      calendarMonth: number;
      periods: { fiscalYear: number; periodNumber: number; name: string }[];
      audits: number;
    }>(sql`
      select o.name,
             o.base_currency as "baseCurrency",
             o.settings,
             (select year_start_month from fiscal_calendars
               where org_id = o.id and is_default) as "calendarMonth",
             (select jsonb_agg(jsonb_build_object(
                       'fiscalYear', p.fiscal_year,
                       'periodNumber', p.period_number,
                       'name', p.name
                     ) order by p.starts_on)
                from accounting_periods p where p.org_id = o.id) as periods,
             (select count(*)::int from audit_log a
               where a.org_id = o.id and a.table_name = 'orgs') as audits
        from orgs o where o.id = ${orgId}`);
    assert.ok(row.rows[0], "scratch organization exists");
    return row.rows[0]!;
  });
}

async function addAccount(
  fixture: Fixture,
  type: string,
  options: { active?: boolean; summary?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await withOrgContext(fixture.orgId, () =>
    db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values
        (${id}, ${fixture.orgId}, ${id.slice(0, 8)}, ${`Control ${id.slice(0, 8)}`},
         ${type}, ${options.summary ?? false}, ${options.active ?? true}, false,
         false, '[]'::jsonb, '{}'::jsonb, true)`),
  );
  return id;
}

async function installAuditFailure(
  actorId: string,
): Promise<() => Promise<void>> {
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const functionName = `settings_audit_failure_${suffix}`;
  const triggerName = `settings_audit_failure_trigger_${suffix}`;
  await withBypassContext(() =>
    db.execute(
      sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.table_name = 'orgs' and new.actor_id = '${actorId}'::uuid then
          raise exception 'forced settings audit failure';
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function public."${functionName}"();
    `),
    ),
  );
  return async () => {
    await withBypassContext(() =>
      db.execute(
        sql.raw(`
        drop trigger if exists "${triggerName}" on audit_log;
        drop function if exists public."${functionName}"();
      `),
      ),
    );
  };
}

async function waitForSettingsWriters(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waiters = await withBypassContext(() =>
      db.execute<{ count: number }>(sql`
        select count(*)::int as count
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
           and query ilike '%orgs%'`),
    );
    if ((waiters.rows[0]?.count ?? 0) >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "both settings writers did not park on the organization row lock",
  );
}

test(
  "users-manage authority cannot write accounting policy; setup authority can",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture, ["admin.users.manage"]);
      const readable = await withOrgContext(fixture.orgId, () => GET());
      assert.equal(readable.status, 200);
      assert.deepEqual(await readable.json(), {
        org: {
          name: (await settingsState(fixture.orgId)).name,
          legalName: "",
          country: "CA",
          defaultLocale: "en",
        },
      });
      assert.deepEqual(routeState.requestedPermissions, ["admin.users.manage"]);
      routeState.requestedPermissions = [];

      const denied = await put(fixture, {
        baseCurrency: "USD",
        fiscalYearStartMonth: 4,
        taxFramework: "ias12",
        reportPdfStyle: "formal",
        fairValueRangePolicy: "off",
        controlAccounts: { ar: fixture.accounts.ar },
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(routeState.requestedPermissions, ["admin.setup.manage"]);
      assert.equal((await settingsState(fixture.orgId)).audits, 0);

      authorize(fixture);
      const allowed = await put(fixture, { taxFramework: "ias12" });
      assert.equal(allowed.status, 200);
      assert.equal(
        (await settingsState(fixture.orgId)).settings.taxFramework,
        "ias12",
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "audit insertion failure rolls back org, fiscal calendar, periods, and evidence",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      authorize(fixture);
      const before = await settingsState(fixture.orgId);
      removeFailure = await installAuditFailure(fixture.actorId);

      await assert.rejects(
        () => put(fixture, { name: "Must Roll Back", fiscalYearStartMonth: 4 }),
        /forced settings audit failure/,
      );
      assert.deepEqual(await settingsState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "concurrent locale and accounting-policy writes preserve both disjoint changes",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    const holder = new Client({
      connectionString: process.env.OPENBOOKS_DB_URL,
    });
    let holderOpen = false;
    try {
      authorize(fixture);
      await holder.connect();
      holderOpen = true;
      await holder.query("begin");
      await holder.query(
        "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
        [fixture.orgId],
      );
      await holder.query("select id from orgs where id = $1 for update", [
        fixture.orgId,
      ]);

      const localeWrite = put(fixture, { defaultLocale: "fr" });
      const policyWrite = put(fixture, { taxFramework: "ias12" });
      await waitForSettingsWriters();
      await holder.query("commit");
      await holder.end();
      holderOpen = false;

      const responses = await Promise.all([localeWrite, policyWrite]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
      );
      const after = await settingsState(fixture.orgId);
      assert.equal(after.settings.defaultLocale, "fr");
      assert.equal(after.settings.taxFramework, "ias12");
      assert.equal(after.audits, 2);
    } finally {
      routeState.authz = null;
      if (holderOpen) {
        await holder.query("rollback").catch(() => {});
        await holder.end().catch(() => {});
      }
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "base currency changes before ledger evidence and locks after the first journal line",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const initial = await put(fixture, { baseCurrency: "USD" });
      assert.equal(initial.status, 200);
      assert.equal((await settingsState(fixture.orgId)).baseCurrency, "USD");

      const entryId = randomUUID();
      await withOrgContext(fixture.orgId, async () => {
        await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin)
        values
          (${entryId}, ${fixture.orgId}, ${fixture.bookId}, ${fixture.subsidiaryId},
           'SETTINGS-LOCK', ${fixture.date}, ${fixture.periodId},
           'base currency lock evidence', 'draft', 'manual')`);
        await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate)
        values
          (${fixture.orgId}, ${entryId}, 1, ${fixture.accounts.bank},
           ${fixture.subsidiaryId}, '1', 'CAD', '1', '1'),
          (${fixture.orgId}, ${entryId}, 2, ${fixture.accounts.revenue},
           ${fixture.subsidiaryId}, '-1', 'CAD', '-1', '1')`);
      });

      const beforeLockedAttempt = await settingsState(fixture.orgId);
      const locked = await put(fixture, { baseCurrency: "EUR" });
      assert.equal(locked.status, 409);
      assert.deepEqual(await locked.json(), {
        error: "base-currency-locked",
        message: "Cannot change base currency after postings exist.",
      });
      assert.deepEqual(await settingsState(fixture.orgId), beforeLockedAttempt);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "posted and closed accounting history refuses fiscal relabelling without mutation",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const entryId = randomUUID();
      await withOrgContext(fixture.orgId, async () => {
        await db.execute(sql`
          insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
             period_id, memo, status, origin)
          values
            (${entryId}, ${fixture.orgId}, ${fixture.bookId}, ${fixture.subsidiaryId},
             'FISCAL-HISTORY-LOCK', ${fixture.date}, ${fixture.periodId},
             'immutable fiscal history', 'draft', 'manual')`);
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate)
          values
            (${fixture.orgId}, ${entryId}, 1, ${fixture.accounts.bank},
             ${fixture.subsidiaryId}, '1', 'CAD', '1', '1'),
            (${fixture.orgId}, ${entryId}, 2, ${fixture.accounts.revenue},
             ${fixture.subsidiaryId}, '-1', 'CAD', '-1', '1')`);
        await db.execute(sql`
          update journal_entries
             set status = 'posted', posted_at = now(), posted_by = ${fixture.actorId}
           where id = ${entryId} and org_id = ${fixture.orgId}`);
        await db.execute(sql`
          insert into period_locks
            (org_id, period_id, book_id, subsidiary_id, module, state, reason)
          values
            (${fixture.orgId}, ${fixture.periodId}, ${fixture.bookId},
             ${fixture.subsidiaryId}, 'gl', 'closed',
             'immutable fiscal history regression')`);
      });

      const before = await settingsState(fixture.orgId);
      const response = await put(fixture, {
        name: "Must Not Change",
        fiscalYearStartMonth: 4,
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "fiscal-calendar-locked",
        message:
          "Cannot change the fiscal calendar after postings or period closure.",
      });
      assert.deepEqual(await settingsState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "a fresh organization can configure its fiscal-year start month",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const response = await put(fixture, { fiscalYearStartMonth: 4 });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        changed: true,
        periodsRederived: true,
      });

      const after = await settingsState(fixture.orgId);
      assert.equal(after.settings.fiscalYearStartMonth, 4);
      assert.equal(after.calendarMonth, 4);
      assert.deepEqual(after.periods, [
        { fiscalYear: 2027, periodNumber: 4, name: "Jul 2026" },
      ]);
      assert.equal(after.audits, 1);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "control mappings reject inactive, summary, and wrong-type accounts and accept valid roles",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const inactive = await addAccount(fixture, "asset_receivable", {
        active: false,
      });
      const summary = await addAccount(fixture, "asset_receivable", {
        summary: true,
      });
      const wrongType = fixture.accounts.revenue;

      for (const [label, accountId, message] of [
        ["inactive", inactive, /inactive/],
        ["summary", summary, /summary/],
        ["wrong type", wrongType, /incompatible/],
      ] as const) {
        const response = await put(fixture, {
          controlAccounts: { ar: accountId },
        });
        assert.equal(response.status, 400, label);
        assert.match(
          ((await response.json()) as { error: string }).error,
          message,
          label,
        );
      }
      assert.equal((await settingsState(fixture.orgId)).audits, 0);

      const valid = await put(fixture, {
        controlAccounts: {
          ar: fixture.accounts.ar,
          ap: fixture.accounts.ap,
          bank: fixture.accounts.bank,
          taxCollected: fixture.accounts.taxOutput,
          taxPaid: fixture.accounts.taxInput,
          employeePayable: fixture.accounts.ap,
        },
      });
      assert.equal(valid.status, 200);
      const after = await settingsState(fixture.orgId);
      assert.deepEqual(after.settings.controlAccounts, {
        ar: fixture.accounts.ar,
        ap: fixture.accounts.ap,
        bank: fixture.accounts.bank,
        fxRealizedGainLoss: fixture.accounts.fxGainLoss,
        taxCollected: fixture.accounts.taxOutput,
        taxPaid: fixture.accounts.taxInput,
        employeePayable: fixture.accounts.ap,
      });
      assert.equal(after.audits, 1);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);
