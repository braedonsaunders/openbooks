import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// A cashier-scoped bank drop rides its own permission: cash_sales.deposit
// opens the constrained deposit path, and nothing else. These round trips
// prove the gate (403 without the grant) and the happy path (201 with a
// posted transfer the bookkeeper matches in Banking) through the real
// route, writer and posting kernel.
const root = pathToFileURL(process.cwd() + "/").href;
const state: { orgId: string; actorId: string; permissions: string[] } = {
  orgId: "",
  actorId: "",
  permissions: [],
};
Object.assign(globalThis, { __cashDepositRouteState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const { readFileSync } = await import("node:fs");
const engineExports = JSON.parse(readFileSync(process.cwd() + "/engine/package.json", "utf8"))
  .exports as Record<string, string>;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../../../../lib/authz" || specifier === "@/lib/authz")
      return virtual(`
      export async function getAuthz() {
        const s = globalThis.__cashDepositRouteState;
        return { user: { orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: new Set(s.permissions), allowedSubsidiaryIds: null };
      }
      export { can, guardSubsidiaryScope, subsidiariesInScope } from '${root}web/lib/authz.ts'
    `);
    if (specifier.startsWith("@openbooks/engine/")) {
      const subpath = "./" + specifier.slice("@openbooks/engine/".length);
      const target = engineExports[subpath];
      if (typeof target === "string") return next(root + "engine/" + target.slice(2), context);
      return next(root + specifier.slice("@openbooks/".length), context);
    }
    return next(specifier, context);
  },
});
const { db, withOrgContext, withOrg } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { GET, POST } = await import("./route.ts");
const { installTrustedTestDatabaseBypass } =
  await import("@openbooks/engine/testing/database-bypass");
installTrustedTestDatabaseBypass();

const CASHIER = ["cash_sales.read", "cash_sales.create", "cash_sales.post", "cash_sales.deposit"];
const NO_DEPOSIT = ["cash_sales.read", "cash_sales.create", "cash_sales.post"];

async function fixture(): Promise<{ orgId: string; saleId: string; cleanup: () => Promise<void> }> {
  const org = await createScratchOrg();
  state.orgId = org.orgId;
  state.actorId = await createScratchUser(org.orgId, "Till Cashier", "cashier");
  state.permissions = CASHIER;
  await db.execute(sql`
    update orgs set settings = settings
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"cashSales": true}'::jsonb)
     where id = ${org.orgId}`);
  const tillId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${tillId}, ${org.orgId}, '1015', 'Till Cash', 'asset_current_other', false, true, false, false, null, '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    update orgs set settings = settings || jsonb_build_object('cashSales',
      coalesce(settings->'cashSales', '{}'::jsonb) ||
      jsonb_build_object('depositAccountIds', jsonb_build_array(${org.accounts.bank}::text)))
     where id = ${org.orgId}`);
  const saleId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
    values (${saleId}, ${org.orgId}, 'cash_sale', 'draft', 'CS-ROUTE', ${org.subsidiaryId},
            ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1',
            '80.0000', '0', '80.0000', '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_tenders (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference)
    values (${org.orgId}, ${saleId}, 1, 'cash', 'cash', ${tillId}, null, '800000', 'CAD', null)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, quantity, unit_price, custom)
    values (${randomUUID()}, ${org.orgId}, ${saleId}, 1, ${org.accounts.revenue},
            '80.0000', '80.0000', '0', '1', '80.0000', '{}'::jsonb)`);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${saleId} and org_id = ${org.orgId}`,
  );
  await withOrg(org.orgId, () =>
    postDocument(saleId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  return { orgId: org.orgId, saleId, cleanup: () => dropScratchOrg(org.orgId) };
}

async function postDrop(
  orgId: string,
  saleId: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  const response = await withOrgContext(orgId, () =>
    POST(
      new Request(`http://cash.test/api/cash-sales/${saleId}/deposit`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }) as never,
      { params: { id: saleId } } as never,
    ),
  );
  return {
    status: response.status,
    json: (await response.json().catch(() => null)) as Record<string, unknown>,
  };
}

test("a till without the deposit grant is refused before any write", async () => {
  const { orgId, saleId, cleanup } = await fixture();
  try {
    state.permissions = NO_DEPOSIT;
    const org = await db.execute<{ date: string; bank: string }>(
      sql`
      select (select document_date::text from documents where org_id = ${orgId} and id = ${saleId}) as date,
             (select id::text from accounts where org_id = ${orgId} and number = '1000') as bank`,
      "objects",
    );
    const denied = await postDrop(
      orgId,
      saleId,
      {
        amount: "10.0000",
        date: org[0]!.date,
        bankAccountId: org[0]!.bank,
        slipNumber: "NOPE",
      },
      randomUUID(),
    );
    assert.equal(denied.status, 403);
    assert.match(String(denied.json.error), /cash_sales\.deposit/);
    const count = (
      await db.execute<{ n: string }>(
        sql`
      select count(*)::text as n from documents where org_id = ${orgId} and kind = 'transfer'`,
        "objects",
      )
    )[0]?.n;
    assert.equal(count, "0");
  } finally {
    await cleanup();
  }
});

test("a cashier records a posted bank drop", async () => {
  const { orgId, saleId, cleanup } = await fixture();
  try {
    state.permissions = CASHIER;
    const org = await db.execute<{ date: string; bank: string }>(
      sql`
      select (select document_date::text from documents where org_id = ${orgId} and id = ${saleId}) as date,
             (select id::text from accounts where org_id = ${orgId} and number = '1000') as bank`,
      "objects",
    );
    const saved = await postDrop(
      orgId,
      saleId,
      {
        amount: "30.0000",
        date: org[0]!.date,
        bankAccountId: org[0]!.bank,
        slipNumber: "SLIP-ROUTE-1",
      },
      randomUUID(),
    );
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    assert.equal(saved.json.posted, true, JSON.stringify(saved.json));
    assert.ok(typeof saved.json.id === "string" && saved.json.id.length > 0);
    // A second drop past the remaining till cash refuses with the remainder.
    const over = await postDrop(
      orgId,
      saleId,
      {
        amount: "60.0000",
        date: org[0]!.date,
        bankAccountId: org[0]!.bank,
        slipNumber: "SLIP-ROUTE-2",
      },
      randomUUID(),
    );
    assert.equal(over.status, 422, JSON.stringify(over.json));
    assert.match(String(over.json.error), /undropped till cash 50\.0000/);
  } finally {
    await cleanup();
  }
});

async function getDrops(
  orgId: string,
  saleId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await withOrgContext(orgId, () =>
    GET(
      new Request(`http://cash.test/api/cash-sales/${saleId}/deposit`, {
        method: "GET",
        headers: { accept: "application/json" },
      }) as never,
      { params: { id: saleId } } as never,
    ),
  );
  return {
    status: response.status,
    json: (await response.json().catch(() => null)) as Record<string, unknown>,
  };
}

test("a sale lists its recorded drops and hides them without the grant", async () => {
  const { orgId, saleId, cleanup } = await fixture();
  try {
    state.permissions = CASHIER;
    const org = await db.execute<{ date: string; bank: string }>(
      sql`
      select (select document_date::text from documents where org_id = ${orgId} and id = ${saleId}) as date,
             (select id::text from accounts where org_id = ${orgId} and number = '1000') as bank`,
      "objects",
    );
    const saved = await postDrop(
      orgId,
      saleId,
      {
        amount: "30.0000",
        date: org[0]!.date,
        bankAccountId: org[0]!.bank,
        slipNumber: "SLIP-LIST-1",
      },
      randomUUID(),
    );
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    const listed = await getDrops(orgId, saleId);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const drops = listed.json.drops as Record<string, unknown>[];
    assert.equal(drops.length, 1);
    assert.equal(drops[0]!.documentNumber, saved.json.documentNumber);
    assert.equal(drops[0]!.slipNumber, "SLIP-LIST-1");
    assert.equal(drops[0]!.status, "posted");
    // Without the grant the list refuses like the recording does.
    state.permissions = NO_DEPOSIT;
    const denied = await getDrops(orgId, saleId);
    assert.equal(denied.status, 403);
    assert.match(String(denied.json.error), /cash_sales\.deposit/);
  } finally {
    await cleanup();
  }
});
