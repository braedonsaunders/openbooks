import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Foreign-currency expense lines convert into the report currency at the
// organization's dated exchange rate, an explicit rate the expense FX policy
// allows, or the amount a statement billed. The line keeps its original
// currency, amounts and rate evidence; the converted amount totals and posts.
const stateKey = Symbol.for("openbooks.expense-foreign-currency-test");
const routeState: { gate: unknown } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const virtual = (source: string) => ({
  shortCircuit: true as const,
  format: "module" as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (
      resolved.url.endsWith("/web/lib/authz.ts") &&
      !(context.parentURL ?? "").startsWith("data:")
    ) {
      const nextServer = nextResolve("next/server", context).url;
      return virtual(`
        export * from ${JSON.stringify(resolved.url)};
        import { can } from ${JSON.stringify(resolved.url)};
        const state = globalThis[Symbol.for('openbooks.expense-foreign-currency-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function getAuthz() { return state.gate }
        export async function guardPermission(permission) {
          if (!state.gate) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          if (!can(state.gate, permission)) return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 });
          return state.gate;
        }
      `);
    }
    return resolved;
  },
});

const { withBypassContext, db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const reportRoute = await import("./[id]/route.ts");
const { GET: quote } = await import("./fx-rate/route.ts");
const { POST: action } = await import("./actions/route.ts");
const { addCalendarDays } = await import("@openbooks/engine/platform/civil-date");
test.after(() => hooks.deregister());

/** A refusal raised by the database, matched on its own message. */
const databaseRefusal = (pattern: RegExp) => (error: unknown) =>
  pattern.test(
    String((error as { cause?: { message?: unknown } }).cause?.message ?? (error as Error).message),
  );

async function setup() {
  const org = await withBypassContext(() => createScratchOrg());
  // The expense falls on the organization's open business date, three days
  // after the newest euro quote and well after the last pound quote.
  const expenseDate = org.date;
  const eurQuoted = addCalendarDays(expenseDate, -3);
  const gbpQuoted = addCalendarDays(expenseDate, -150);
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Expense clerk", "expense_clerk"),
  );
  const employee = randomUUID();
  const report = randomUUID();
  const eurRate = randomUUID();
  const employeePayable = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${employeePayable}, ${org.orgId}, '2110', 'Employee Reimbursements Payable', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,employeePayable}', to_jsonb(${employeePayable}::text), true)
       where id = ${org.orgId}`);
    await db.execute(
      sql`insert into parties (id, org_id, kind, display_name, is_active, custom) values (${employee}, ${org.orgId}, 'employee', 'Riley Traveller', true, '{}'::jsonb)`,
    );
    await db.execute(
      sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employee})`,
    );
    await db.execute(sql`
      insert into fx_rate_types (org_id, key, name) values (${org.orgId}, 'spot', 'Spot')
      -- expected when the organization already carries its spot series
      on conflict do nothing`);
    await db.execute(sql`
      insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate, rate_type, source)
      values (${eurRate}, ${org.orgId}, 'EUR', 'CAD', ${eurQuoted}, '1.4823', 'spot', 'manual'),
             (${randomUUID()}, ${org.orgId}, 'GBP', 'CAD', ${gbpQuoted}, '1.8400', 'spot', 'manual')`);
    await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
      values (${report}, ${org.orgId}, 'expense_report', 'draft', 'EXP-FX-1', ${expenseDate}, ${employee}, ${org.subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`);
  });
  routeState.gate = {
    user: { orgId: org.orgId, id: actor, roles: [], isSuperAdmin: false },
    permissions: new Set(["expenses.read", "expenses.create", "ap.post"]),
    allowedSubsidiaryIds: null,
  };
  return { org, report, eurRate, employeePayable, expenseDate, eurQuoted, gbpQuoted };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function teardown(fixture: Fixture) {
  routeState.gate = null;
  await withBypassContext(() =>
    db.execute(sql`delete from employee_roles where org_id = ${fixture.org.orgId}`),
  );
  await withBypassContext(() => dropScratchOrg(fixture.org.orgId));
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function revision(fixture: Fixture): Promise<string> {
  const res = await reportRoute.GET(
    new Request(`http://openbooks.test/api/expenses/${fixture.report}`),
    params(fixture.report),
  );
  assert.equal(res.status, 200);
  return String(((await res.json()) as { doc: { updated_at: string } }).doc.updated_at);
}

async function saveLine(
  fixture: Fixture,
  foreignCurrency: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const body = {
    expectedUpdatedAt: await revision(fixture),
    lines: [
      {
        accountId: fixture.org.accounts.cogs,
        description: "Hotel, Paris",
        amount: "0",
        settlementType: "out_of_pocket",
        foreignCurrency,
        ...extra,
      },
    ],
  };
  const res = await reportRoute.PATCH(
    new Request(`http://openbooks.test/api/expenses/${fixture.report}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(fixture.report),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function storedLine(fixture: Fixture) {
  return withBypassContext(
    async () =>
      (
        await db.execute<{
          amount: string;
          tax_amount: string;
          original_currency: string | null;
          original_amount: string | null;
          original_fx_rate: string | null;
          original_fx_evidence: Record<string, unknown> | null;
          total: string;
        }>(
          sql`
    select l.amount::text, l.tax_amount::text, l.original_currency, l.original_amount::text, l.original_fx_rate::text,
           l.original_fx_evidence, d.total::text
      from document_lines l join documents d on d.id = l.document_id and d.org_id = l.org_id
     where l.org_id = ${fixture.org.orgId} and l.document_id = ${fixture.report}`,
          "objects",
        )
      )[0],
  );
}

test("a foreign line converts at the dated rate, keeps its evidence, and posts the converted amount", async () => {
  const fixture = await setup();
  try {
    const preview = await quote(
      new Request(
        `http://openbooks.test/api/expenses/fx-rate?currency=EUR&date=${fixture.expenseDate}&reportId=${fixture.report}`,
      ),
    );
    assert.equal(preview.status, 200);
    const shown = (await preview.json()) as {
      quote: { rate: string; observationDate: string };
      allowRateOverride: boolean;
    };
    assert.deepEqual(
      {
        rate: shown.quote.rate,
        date: shown.quote.observationDate,
        override: shown.allowRateOverride,
      },
      { rate: "1.4823000000", date: fixture.eurQuoted, override: false },
    );

    const saved = await saveLine(fixture, {
      currency: "EUR",
      amount: "100",
      rateDate: fixture.expenseDate,
      method: "rate_table",
      rate: shown.quote.rate,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const line = await storedLine(fixture);
    assert.equal(line?.amount, "148.2300");
    assert.equal(line?.total, "148.2300", "the converted amount totals the report");
    assert.equal(line?.original_currency, "EUR");
    assert.equal(line?.original_amount, "100.0000");
    assert.equal(line?.original_fx_rate, "1.4823000000");
    assert.equal(line?.original_fx_evidence?.method, "rate_table");
    assert.equal(line?.original_fx_evidence?.observationId, fixture.eurRate);
    assert.equal(line?.original_fx_evidence?.observationDate, fixture.eurQuoted);
    assert.equal(line?.original_fx_evidence?.rateType, "spot");
    assert.match(String(line?.original_fx_evidence?.digest), /^[a-f0-9]{64}$/);

    // A rate edited after the operator saw it refuses instead of converting at another figure.
    const moved = await saveLine(fixture, {
      currency: "EUR",
      amount: "100",
      rateDate: fixture.expenseDate,
      method: "rate_table",
      rate: "1.5000000000",
    });
    assert.equal(moved.status, 409);
    assert.match(String(moved.body.error), /is now 1\.4823000000/);

    await withBypassContext(() =>
      db.execute(
        sql`update documents set status = 'approved' where id = ${fixture.report} and org_id = ${fixture.org.orgId}`,
      ),
    );
    const posted = await action(
      new Request("http://openbooks.test/api/expenses/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "post", documentId: fixture.report }),
      }),
    );
    assert.equal(posted.status, 200, JSON.stringify(await posted.clone().json()));
    const journal = await withBypassContext(
      async () =>
        await db.execute<{ account_id: string; amount: string }>(
          sql`
      select l.account_id, l.amount::text from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where e.org_id = ${fixture.org.orgId} and e.source_document_id = ${fixture.report}
       order by l.amount desc`,
          "objects",
        ),
    );
    assert.deepEqual(
      journal.map((row) => [row.account_id, row.amount]),
      [
        [fixture.org.accounts.cogs, "148.2300"],
        [fixture.employeePayable, "-148.2300"],
      ],
      "the expense and the reimbursement post the converted amount",
    );
  } finally {
    await teardown(fixture);
  }
});

test("a missing or stale exchange rate refuses with where to add one", async () => {
  const fixture = await setup();
  try {
    const missing = await saveLine(fixture, {
      currency: "USD",
      amount: "40",
      rateDate: fixture.expenseDate,
      method: "rate_table",
    });
    assert.equal(missing.status, 422);
    assert.ok(
      String(missing.body.error).includes(
        `No spot exchange rate converts USD to CAD on or before ${fixture.expenseDate}`,
      ),
      String(missing.body.error),
    );
    assert.match(String(missing.body.error), /Setup → Exchange rates/);
    const stale = await saveLine(fixture, {
      currency: "GBP",
      amount: "40",
      rateDate: fixture.expenseDate,
      method: "rate_table",
    });
    assert.equal(stale.status, 422);
    assert.ok(
      String(stale.body.error).includes(
        `dated ${fixture.gbpQuoted}, 150 days old, beyond the 31-day rate age limit`,
      ),
      String(stale.body.error),
    );
    assert.equal(await storedLine(fixture), undefined, "a refused save writes no line");
    const preview = await quote(
      new Request(
        `http://openbooks.test/api/expenses/fx-rate?currency=USD&date=${fixture.expenseDate}`,
      ),
    );
    const body = (await preview.json()) as {
      quote: unknown;
      refusal: { code: string; remedy: string };
    };
    assert.equal(body.quote, null);
    assert.equal(body.refusal.code, "expense_fx_rate_missing");
    assert.match(body.refusal.remedy, /enter the amount billed in CAD/);
  } finally {
    await teardown(fixture);
  }
});

test("an explicit rate needs an expense FX policy in force on the expense date", async () => {
  const fixture = await setup();
  try {
    const override = {
      currency: "EUR",
      amount: "100",
      rateDate: fixture.expenseDate,
      method: "override",
      rate: "1.5",
      reason: "Bank conversion advice for the booking",
    };
    const refused = await saveLine(fixture, override);
    assert.equal(refused.status, 422);
    assert.match(String(refused.body.error), /does not allow an explicit exchange rate/);
    assert.match(String(refused.body.error), /Setup → Expense FX Policies/);

    await withBypassContext(() =>
      db.execute(sql`
      insert into expense_fx_policies (org_id, effective_from, allow_rate_override, reason)
      values (${fixture.org.orgId}, ${addCalendarDays(fixture.expenseDate, 1)}, true, 'Travel policy allows bank conversion rates')`),
    );
    assert.equal(
      (await saveLine(fixture, override)).status,
      422,
      "a later policy version does not reinterpret an earlier expense",
    );

    await withBypassContext(() =>
      db.execute(sql`
      insert into expense_fx_policies (org_id, effective_from, allow_rate_override, reason)
      values (${fixture.org.orgId}, ${addCalendarDays(fixture.expenseDate, -30)}, true, 'Travel policy allows bank conversion rates')`),
    );
    const saved = await saveLine(fixture, override);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const line = await storedLine(fixture);
    assert.equal(line?.amount, "150.0000");
    assert.equal(line?.original_fx_evidence?.method, "override");
    assert.equal(line?.original_fx_evidence?.reason, "Bank conversion advice for the booking");
    assert.equal(line?.original_fx_evidence?.source, "operator");
    await assert.rejects(
      withBypassContext(() =>
        db.execute(
          sql`update expense_fx_policies set allow_rate_override = false where org_id = ${fixture.org.orgId}`,
        ),
      ),
      databaseRefusal(/retained history/),
      "policy versions are append-only",
    );
  } finally {
    await teardown(fixture);
  }
});

test("a billed home-currency amount is the converted line exactly, with its rate derived", async () => {
  const fixture = await setup();
  try {
    const saved = await saveLine(fixture, {
      currency: "EUR",
      amount: "100",
      rateDate: fixture.expenseDate,
      method: "billed_amount",
      billedAmount: "151.37",
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const line = await storedLine(fixture);
    assert.equal(line?.amount, "151.3700");
    assert.equal(line?.original_fx_rate, "1.5137000000");
    assert.equal(line?.original_fx_evidence?.method, "billed_amount");
    assert.equal(line?.original_fx_evidence?.billedAmount, "151.3700");
    // Storage refuses evidence that disagrees with the line it describes.
    await assert.rejects(
      withBypassContext(() =>
        db.execute(sql`
        update document_lines set original_fx_rate = '1.6' where org_id = ${fixture.org.orgId} and document_id = ${fixture.report}`),
      ),
      databaseRefusal(/document_lines_original_currency_evidence/),
    );
  } finally {
    await teardown(fixture);
  }
});
