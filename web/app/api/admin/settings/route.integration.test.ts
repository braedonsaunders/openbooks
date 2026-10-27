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
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
  requestedPermissions: string[];
  deny(permission: string | null): NextResponse;
}
const routeState: RouteState = {
  authz: null,
  requestedPermissions: [],
  deny(permission) {
    return permission
      ? NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 })
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

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
  export function guardUnrestrictedScope(authz) {
    return authz.allowedSubsidiaryIds === null ? null : Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
  }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@/lib/authz" ||
      (specifier === "../../../../lib/authz" && context.parentURL?.includes("admin/settings"))
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

const routeUrl = "./route.ts?accounting-policy-boundary-test";
const { GET, PUT } = (await import(routeUrl)) as typeof import("./route.ts");
const { CONTROL_ACCOUNT_ROLES } = await import("@openbooks/engine/records/control-accounts");
const { db, withBypass, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { updateCompanySettings } = await import("../../../../lib/company-settings");

/** Drizzle wraps driver errors, so PostgreSQL messages live on `cause`. */
function postgresCauseMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause;
  return String(cause?.message ?? "");
}

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
    const actorId = await createScratchUser(org.orgId, "Settings Admin", "settings_admin");
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2)
      on conflict (code) do nothing`);
    await db.execute(sql`
      update orgs
         set settings = settings || '{"reportingFramework":"us_gaap"}'::jsonb
       where id = ${org.orgId}`);
    return { ...org, actorId };
  });
}

function authorize(fixture: Fixture, permissions = ["admin.setup.manage"]): void {
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

test("the shared settings writer refuses subsidiary-restricted actors", async () => {
  await assert.rejects(
    () =>
      updateCompanySettings(
        {
          orgId: "company-one",
          id: "actor-one",
          allowedSubsidiaryIds: new Set(["subsidiary-one"]),
        },
        { name: "Must Not Change" },
      ),
    (error: unknown) => (error as { status?: number }).status === 403,
  );
});

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
    }>(
      sql`
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
        from orgs o where o.id = ${orgId}`,
      "objects",
    );
    assert.ok(row[0], "scratch organization exists");
    return row[0]!;
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

async function installAuditFailure(actorId: string): Promise<() => Promise<void>> {
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
      db.execute<{ count: number }>(
        sql`
        select count(*)::int as count
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Lock'
           and query ilike '%orgs%'`,
        "objects",
      ),
    );
    if ((waiters[0]?.count ?? 0) >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("both settings writers did not park on the organization row lock");
}

test("users-manage authority cannot write accounting policy; setup authority can", async () => {
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
        address: null,
        legalForm: null,
        taxClassification: null,
        taxIds: {},
        defaultLocale: "en",
        timeZone: "UTC",
        reportingFramework: "us_gaap",
        taxFramework: "asc740",
        billing: { defaultPaymentTermsId: null },
      },
    });
    // The route factory checks the read permission once for the whole request.
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
    assert.equal((await settingsState(fixture.orgId)).settings.taxFramework, "ias12");

    const invalid = await put(fixture, { reportingFramework: "local_gaap" });
    assert.equal(invalid.status, 400);
    const refusal = await invalid.json();
    assert.match(refusal.error, /us_gaap/);
    assert.match(refusal.error, /ifrs/);
    assert.deepEqual(refusal.issues, [{ path: "reportingFramework", message: refusal.error }]);

    const explicit = await put(fixture, { reportingFramework: "ifrs" });
    assert.equal(explicit.status, 200);
    assert.equal((await settingsState(fixture.orgId)).settings.reportingFramework, "ifrs");
    const frameworkAudit = await withOrgContext(fixture.orgId, () =>
      db.execute<{ change: [string, string] }>(
        sql`
          select changes->'reportingFramework' as change
            from audit_log
           where org_id = ${fixture.orgId}
             and table_name = 'orgs'
             and changes ? 'reportingFramework'
           order by at desc
           limit 1`,
        "objects",
      ),
    );
    assert.deepEqual(frameworkAudit[0]?.change, ["us_gaap", "ifrs"]);

    // Tax presentation is an independent policy. Changing it back to ASC
    // 740 must not move the authoritative financial-reporting framework.
    const taxOnly = await put(fixture, { taxFramework: "asc740" });
    assert.equal(taxOnly.status, 200);
    const afterTaxEdit = await settingsState(fixture.orgId);
    assert.equal(afterTaxEdit.settings.taxFramework, "asc740");
    assert.equal(afterTaxEdit.settings.reportingFramework, "ifrs");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("subsidiary-restricted setup administrators cannot change company settings", async () => {
  const fixture = await seed();
  try {
    authorize(fixture);
    const before = await settingsState(fixture.orgId);
    routeState.authz!.allowedSubsidiaryIds = new Set([fixture.subsidiaryId]);

    const response = await put(fixture, { name: "Restricted Change" });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.deepEqual(await settingsState(fixture.orgId), before);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("audit insertion failure rolls back org, fiscal calendar, periods, and evidence", async () => {
  const fixture = await seed();
  let removeFailure: (() => Promise<void>) | undefined;
  try {
    authorize(fixture);
    const before = await settingsState(fixture.orgId);
    removeFailure = await installAuditFailure(fixture.actorId);

    await assert.rejects(
      () => put(fixture, { name: "Must Roll Back", fiscalYearStartMonth: 4 }),
      (error: unknown) => postgresCauseMessage(error).includes("forced settings audit failure"),
    );
    assert.deepEqual(await settingsState(fixture.orgId), before);
  } finally {
    routeState.authz = null;
    await removeFailure?.();
    await dropScratchOrg(fixture.orgId);
  }
});

test("concurrent locale and accounting-policy writes preserve both disjoint changes", async () => {
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
    await holder.query("select id from orgs where id = $1 for update", [fixture.orgId]);

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
});

test("base currency changes before ledger evidence and locks after the first journal line", async () => {
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
});

test("posted and closed accounting history refuses fiscal relabelling without mutation", async () => {
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
      message: "Cannot change the fiscal calendar after postings or period closure.",
    });
    assert.deepEqual(await settingsState(fixture.orgId), before);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("a fresh organization can configure its fiscal-year start month", async () => {
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
    assert.deepEqual(after.periods, [{ fiscalYear: 2027, periodNumber: 4, name: "Jul 2026" }]);
    assert.equal(after.audits, 1);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("control mappings reject inactive, summary, and wrong-type accounts and accept valid roles", async () => {
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
      ["wrong type", wrongType, /must be Accounts receivable; the selected account is Income/],
    ] as const) {
      const response = await put(fixture, {
        controlAccounts: { ar: accountId },
      });
      assert.equal(response.status, 400, label);
      assert.match(((await response.json()) as { error: string }).error, message, label);
    }
    assert.equal((await settingsState(fixture.orgId)).audits, 0);

    const before = await settingsState(fixture.orgId);
    const unknown = await put(fixture, {
      controlAccounts: { mfgWIP: fixture.accounts.ar },
    });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "unknown control account role mfgWIP" });
    assert.deepEqual(await settingsState(fixture.orgId), before);

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
});

test("contract creation is refused without the scoped-contracts switch and persists with it", async () => {
  const fixture = await seed();
  try {
    authorize(fixture);
    const gatedOff = await put(fixture, { contractCreation: "booking" });
    assert.equal(gatedOff.status, 404);

    await withBypass(async () => {
      await db.execute(sql`
          update orgs set settings = jsonb_set(
            coalesce(settings, '{}'::jsonb), '{features,revenueContracts}', 'true'::jsonb)
           where id = ${fixture.orgId}`);
    });
    const invalid = await put(fixture, { contractCreation: "on_issue" });
    assert.equal(invalid.status, 400);
    const issues = ((await invalid.json()) as { issues: { path: string }[] }).issues;
    assert.ok(
      issues.some((issue) => issue.path === "contractCreation"),
      "the refusal names the offending field",
    );

    const before = await settingsState(fixture.orgId);
    const stored = await put(fixture, { contractCreation: "booking" });
    assert.equal(stored.status, 200);
    const after = await settingsState(fixture.orgId);
    assert.equal((after.settings.revenue as Record<string, unknown>).contractCreation, "booking");
    assert.equal(after.audits, before.audits + 1);

    const repeated = await put(fixture, { contractCreation: "booking" });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await settingsState(fixture.orgId), after);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("the full settings form saves with unset control roles left blank and names a malformed role", async () => {
  const fixture = await seed();
  try {
    authorize(fixture);
    const before = await settingsState(fixture.orgId);
    const current = (before.settings.controlAccounts ?? {}) as Record<string, string>;
    // The Company tab posts every role, with an empty string for each unset one.
    const formRoles = Object.fromEntries(
      CONTROL_ACCOUNT_ROLES.map((role) => [role, current[role] ?? ""]),
    );
    const saved = await put(fixture, {
      name: "Scratch Renamed Company",
      controlAccounts: formRoles,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const after = await settingsState(fixture.orgId);
    assert.equal(after.name, "Scratch Renamed Company");
    assert.deepEqual(
      after.settings.controlAccounts,
      current,
      "blank roles leave existing mappings unchanged",
    );

    const malformed = await put(fixture, {
      controlAccounts: { ...formRoles, taxPaid: "not-an-account" },
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: "Sales tax paid must be an account id",
      code: "control-account-invalid",
      role: "taxPaid",
      reason: "missing",
    });
    assert.deepEqual(await settingsState(fixture.orgId), after);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("cash-sale till defaults persist through the route and undeclared fields are refused", async () => {
  const fixture = await seed();
  try {
    authorize(fixture);
    const saved = await put(fixture, {
      cashSales: { defaultCashAccountId: fixture.accounts.bank, walkInCustomerId: "" },
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const after = await settingsState(fixture.orgId);
    assert.deepEqual(after.settings.cashSales, { defaultCashAccountId: fixture.accounts.bank });

    // The settings form always sends the till-drop list, empty or not.
    const withDrops = await put(fixture, {
      cashSales: {
        walkInCustomerId: null,
        defaultCashAccountId: fixture.accounts.bank,
        defaultCardAccountId: null,
        defaultBankAccountId: null,
        depositAccountIds: [fixture.accounts.bank],
      },
    });
    assert.equal(withDrops.status, 200, await withDrops.clone().text());
    assert.deepEqual((await settingsState(fixture.orgId)).settings.cashSales, {
      defaultCashAccountId: fixture.accounts.bank,
      depositAccountIds: [fixture.accounts.bank],
    });
    const cleared = await put(fixture, {
      cashSales: { defaultCashAccountId: fixture.accounts.bank, depositAccountIds: [] },
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.deepEqual((await settingsState(fixture.orgId)).settings.cashSales, {
      defaultCashAccountId: fixture.accounts.bank,
    });

    const beforeUndeclared = await settingsState(fixture.orgId);
    const undeclared = await put(fixture, {
      name: "Scratch Undeclared Field",
      tillDefaults: { cash: fixture.accounts.bank },
    });
    assert.equal(undeclared.status, 400);
    assert.deepEqual(
      await settingsState(fixture.orgId),
      beforeUndeclared,
      "a refused save changes nothing",
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});

test("the company default payment terms persist through the route and retire silently", async () => {
  const fixture = await seed();
  try {
    authorize(fixture);
    const termsId = randomUUID();
    await withBypass(() =>
      db.execute(sql`
          insert into payment_terms (id, org_id, name, net_days)
          values (${termsId}, ${fixture.orgId}, 'Net 30', 30)`),
    );
    const saved = await put(fixture, { billing: { defaultPaymentTermsId: termsId } });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual((await settingsState(fixture.orgId)).settings.billing, {
      defaultPaymentTermsId: termsId,
    });
    // A foreign id is refused and changes nothing.
    const foreign = await put(fixture, { billing: { defaultPaymentTermsId: randomUUID() } });
    assert.equal(foreign.status, 400);
    // Clearing the picker stores no default.
    const cleared = await put(fixture, { billing: { defaultPaymentTermsId: null } });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal(
      (await settingsState(fixture.orgId)).settings.billing ?? null,
      null,
      "a cleared default leaves no billing settings behind",
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(fixture.orgId);
  }
});
