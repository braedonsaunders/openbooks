import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * PAYCONF-c/d/e (collapse semantics): the analytics drill collapses
 * pay-run-sourced lines per (entry, account) in the query itself — before
 * any sort or limit — so a reader without payroll.read sees the restricted
 * label and entry totals but no employee name and no per-employee amount. A
 * granted reader sees the same drill unchanged, and totals tie out.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const gate: { permissions: string[] } = { permissions: ["reports.read"] };
Object.assign(globalThis, { __drillGate: gate });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/analytics/drill/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function guardPermission(){
              return {
                user: { id: "user-1", orgId: globalThis.__drillOrgId },
                permissions: new Set(globalThis.__drillGate.permissions),
                allowedSubsidiaryIds: null,
              };
            }
            export function can(authz, perm){ return authz.permissions.has(perm); }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { GET } = await import("./route.ts");
const { db, withBypassContext } = (await import(root + "engine/src/platform/db.ts")) as typeof import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import(root + "node_modules/drizzle-orm/index.js");
const { createScratchOrg, dropScratchOrg } = (await import(root + "engine/src/testing/fixtures.ts")) as typeof import("@openbooks/engine/src/testing/fixtures.ts");
const { PAYROLL_RESTRICTED_PARTY_LABEL } = (await import(root + "web/lib/payroll-confidentiality.ts")) as typeof import("@/lib/payroll-confidentiality.ts");

const NET_A = "4842.17";
const NET_B = "5210.44";
const NAME_A = "Avery Employee";
const NAME_B = "Blake Employee";

async function seedPayroll(org: Awaited<ReturnType<typeof createScratchOrg>>) {
  const empA = randomUUID();
  const empB = randomUUID();
  await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id)
    values (${empA}, ${org.orgId}, 'employee', ${NAME_A}, ${org.subsidiaryId}),
           (${empB}, ${org.orgId}, 'employee', ${NAME_B}, ${org.subsidiaryId})`);
  const payDoc = randomUUID();
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, document_date, posting_date, subsidiary_id, currency, subtotal, tax_total, total, fx_rate, status)
    values (${payDoc}, ${org.orgId}, 'pay_run', 'PAY-1', ${org.date}, ${org.date}, ${org.subsidiaryId}, 'USD', 0, 0, 10052.61, 1, 'approved')`);
  const entryId = randomUUID();
  await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, source_document_id)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'JE-PAY-1', ${org.date}, ${org.periodId}, 'Pay run PAY-1', 'draft', 'document', ${payDoc})`);
  await db.execute(sql`insert into journal_lines (id, org_id, entry_id, line_number, account_id, subsidiary_id, party_id, is_open_item, amount, currency, txn_amount, fx_rate, posting_date)
    values (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ap}, ${org.subsidiaryId}, ${empA}, true, -4842.17, 'USD', -4842.17, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, ${empB}, true, -5210.44, 'USD', -5210.44, 1, ${org.date}),
           (${randomUUID()}, ${org.orgId}, ${entryId}, 3, ${org.accounts.cogs}, ${org.subsidiaryId}, null, false, 10052.61, 'USD', 10052.61, 1, ${org.date})`);
  await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
}

function leakedIdentity(payload: unknown): string | null {
  const text = JSON.stringify(payload);
  for (const secret of [NAME_A, NAME_B]) {
    if (text.includes(secret)) return secret;
  }
  return null;
}

function leakedAmount(payload: unknown): string | null {
  const text = JSON.stringify(payload);
  for (const secret of [NET_A, NET_B]) {
    if (text.includes(secret)) return secret;
  }
  return null;
}

async function drill(orgId: string, account: string, date: string) {
  const res = await GET(new Request(`http://audit.local/api/analytics/drill?mode=account&account=${account}&from=${date}&to=${date}`));
  assert.equal(res.status, 200, `drill answered ${res.status}: ${await res.clone().text()}`);
  return res.json() as Promise<Record<string, unknown>>;
}

test("account drill collapses pay-run lines without the grant", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  (globalThis as Record<string, unknown>).__drillOrgId = org.orgId;
  try {
    await withBypassContext(() => seedPayroll(org));
    gate.permissions = ["reports.read"];
    const body = await drill(org.orgId, org.accounts.ap, org.date);
    assert.equal(leakedIdentity(body), null, "drill leaked an individual identity");
    assert.equal(leakedAmount(body), null, "drill leaked an individual amount");
    assert.ok(JSON.stringify(body).includes(PAYROLL_RESTRICTED_PARTY_LABEL));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("account drill ties out with the grant and shows full detail", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  (globalThis as Record<string, unknown>).__drillOrgId = org.orgId;
  try {
    await withBypassContext(() => seedPayroll(org));
    gate.permissions = ["reports.read"];
    const hidden = await drill(org.orgId, org.accounts.ap, org.date);
    gate.permissions = ["reports.read", "payroll.read"];
    const shown = await drill(org.orgId, org.accounts.ap, org.date);
    const text = JSON.stringify(shown);
    assert.ok(text.includes(NET_A) && text.includes(NAME_B), "granted drill must show both employees");
    assert.equal((hidden as { total: string }).total, (shown as { total: string }).total, "restricted totals must tie to granted totals");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
