import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Daily summary entry creates the day's cash sale as a draft through the
// native document path: one form (date, category/tax-code totals, tenders,
// tips, fees, over/short) in, a validated draft with computed per-line tax,
// tender rows and a canonical close-out bag out.
const root = pathToFileURL(process.cwd() + "/").href;
const state: { orgId: string; actorId: string; permissions: string[]; user: unknown } = {
  orgId: "",
  actorId: "",
  permissions: [],
  user: null,
};
Object.assign(globalThis, { __cashSummaryRouteState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ intl: true, extra: { "server-only": "export {}" } });
const { readFileSync } = await import("node:fs");
const engineExports = JSON.parse(readFileSync(process.cwd() + "/engine/package.json", "utf8"))
  .exports as Record<string, string>;
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__cashSummaryRouteState.user ?? null}",
      );
    }
    if (specifier === "../../../../lib/authz")
      return virtual(`
      export async function getAuthz() {
        const s = globalThis.__cashSummaryRouteState;
        return { user: { orgId: s.orgId, id: s.actorId, roles: [], isSuperAdmin: false }, permissions: new Set(s.permissions), allowedSubsidiaryIds: null };
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
const { db, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { POST } = await import("./route.ts");
const { installTrustedTestDatabaseBypass } =
  await import("@openbooks/engine/testing/database-bypass");
installTrustedTestDatabaseBypass();

async function fixture(): Promise<{
  orgId: string;
  taxCodeId: string;
  date: string;
  cleanup: () => Promise<void>;
}> {
  const org = await createScratchOrg();
  state.orgId = org.orgId;
  state.actorId = await createScratchUser(org.orgId, "Till Cashier", "cashier");
  state.user = {
    id: state.actorId,
    orgId: org.orgId,
    name: "Till Cashier",
    email: "cashier@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: org.orgId,
    homeOrgId: org.orgId,
    homeUserId: state.actorId,
  };
  state.permissions = ["cash_sales.read", "cash_sales.create"];
  await db.execute(sql`
    update orgs set settings = settings
      || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"cashSales": true}'::jsonb)
     where id = ${org.orgId}`);
  const taxCodeId = randomUUID();
  await db.execute(sql`insert into tax_codes (id, org_id, code, name, applies_to, collected_account_id)
    values (${taxCodeId}, ${org.orgId}, 'DAY-TAX', 'Day tax', 'sale', ${org.accounts.taxOutput})`);
  await db.execute(sql`insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from)
    values (${org.orgId}, ${taxCodeId}, '10', '2020-01-01')`);
  const tillId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, currency_restriction, required_dimensions, custom, subsidiary_include_children)
    values (${tillId}, ${org.orgId}, '1015', 'Till Cash', 'asset_current_other', false, true, false, false, null, '[]'::jsonb, '{}'::jsonb, true)`);
  return { orgId: org.orgId, taxCodeId, date: org.date, cleanup: () => dropScratchOrg(org.orgId) };
}

async function postSummary(
  orgId: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await withOrgContext(orgId, () =>
    POST(
      new Request("http://cash.test/api/cash-sales/daily-summary", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify(body),
      }) as never,
    ),
  );
  return {
    status: response.status,
    json: (await response.json().catch(() => null)) as Record<string, unknown>,
  };
}

test("a daily summary creates a taxed draft with tenders and a close-out", async () => {
  const { orgId, taxCodeId, date, cleanup } = await fixture();
  try {
    const org = await db.execute<{ revenue: string; bank: string; till: string }>(
      sql`
      select (select id::text from accounts where org_id = ${orgId} and number = '4000') as revenue,
             (select id::text from accounts where org_id = ${orgId} and number = '1000') as bank,
             (select id::text from accounts where org_id = ${orgId} and number = '1015') as till`,
      "objects",
    );
    const ids = org[0]!;
    // Day total 100 + 10% line tax = 110; card collects 55.00 incl. a 5.00
    // tip; cash counts 60.25 against a +0.25 over: 115.25 tendered.
    const saved = await postSummary(orgId, {
      date,
      lines: [{ accountId: ids.revenue, amount: "100.0000", description: "Food", taxCodeId }],
      tenders: [
        { kind: "cash", accountId: ids.till, amount: "60.2500" },
        { kind: "card", accountId: ids.bank, amount: "55.0000", tipAmount: "5.0000" },
      ],
      closeout: { overShort: "0.2500" },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.json));
    const doc = (saved.json as { doc: Record<string, unknown> }).doc;
    assert.equal(doc.subtotal, "100.0000");
    assert.equal(doc.tax_total, "10.0000");
    assert.equal(doc.total, "110.0000");
    assert.equal(doc.status, "draft");
    assert.deepEqual(doc.custom, {
      closeout: {
        tipsTotal: "5.0000",
        feeTotal: "0.0000",
        overShort: "0.2500",
        serverPartyId: null,
        parts: [{ position: 2, tip: "5.0000", fee: "0.0000" }],
      },
    });
    const tenders = await db.execute<{ kind: string; minor: string }>(
      sql`
      select kind, amount_minor::text as minor from document_tenders
       where org_id = ${orgId} and document_id = ${(saved.json as { doc: { id: string } }).doc.id}
       order by position`,
      "objects",
    );
    assert.deepEqual(
      tenders.map((row) => [row.kind, row.minor]),
      [
        ["cash", "602500"],
        ["card", "550000"],
      ],
    );
  } finally {
    await cleanup();
  }
});

test("a daily summary without the create grant is refused", async () => {
  const { orgId, date, cleanup } = await fixture();
  try {
    state.permissions = ["cash_sales.read"];
    const org = await db.execute<{ revenue: string; till: string }>(
      sql`
      select (select id::text from accounts where org_id = ${orgId} and number = '4000') as revenue,
             (select id::text from accounts where org_id = ${orgId} and number = '1015') as till`,
      "objects",
    );
    const ids = org[0]!;
    const denied = await postSummary(orgId, {
      date,
      lines: [{ accountId: ids.revenue, amount: "10.0000" }],
      tenders: [{ kind: "cash", accountId: ids.till, amount: "10.0000" }],
    });
    assert.equal(denied.status, 403);
    assert.match(String(denied.json.error), /cash_sales\.create/);
  } finally {
    await cleanup();
  }
});
