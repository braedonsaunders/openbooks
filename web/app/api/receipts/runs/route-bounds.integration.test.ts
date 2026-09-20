import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Collection-run creation validates scheduledFor with zod's calendar-aware
 * date pattern, so a September 31 fails closed with a named 400 before the
 * mandate window's ::date casts ever see it — this guards that closed path
 * (a shape-only check here would leak the raw driver failure as a 500).
 * payment_runs.scheduled_for is date.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { orgId: "", actorId: "" };
Object.assign(globalThis, { __collectionRunBoundState: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation") return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() {}; export function usePathname() { return '' }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__collectionRunBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export async function getAuthz() {
          const s = globalThis.__collectionRunBoundState;
          return { user: { orgId: s.orgId, id: s.actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
        }
        export function can() { return true }
        export function guardSubsidiaryScope() { return null }
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting.ts");
const { POST } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fx {
  orgId: string;
  profileId: string;
  invoiceId: string;
  date: string;
}

async function fixture(): Promise<Fx> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  const formatId = randomUUID();
  const profileId = randomUUID();
  const partyBankAccountId = randomUUID();
  const mandateId = randomUUID();
  const invoiceId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into payment_formats
      (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
    values
      (${formatId}, ${org.orgId}, 'NACHA-DD-TEST', 'NACHA debit test',
       'nacha_debit', 'debit', 'US', 'CAD', ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into payment_bank_profiles
      (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
       currency, country, created_by, updated_by)
    values
      (${profileId}, ${org.orgId}, 'Collection profile', ${org.accounts.bank},
       ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA', ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into party_bank_accounts
      (id, org_id, party_id, bank_name, country, currency, routing,
       account_last_four, approved_at, approved_by, created_by, updated_by)
    values
      (${partyBankAccountId}, ${org.orgId}, ${org.customerId}, 'Customer bank',
       'CA', 'CAD', '{}'::jsonb, '1234', ${org.date}, ${actorId}, ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into payment_mandates
      (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference,
       status, signed_on, valid_from, created_by, updated_by)
    values
      (${mandateId}, ${org.orgId}, ${org.customerId}, ${partyBankAccountId},
       'nacha', 'MANDATE-BOUNDS', 'active', ${org.date}, ${org.date},
       ${actorId}, ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values
      (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-BOUNDS',
       ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
       '125', '0', '125', ${actorId})`));
  await withBypassContext(() => db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price,
       amount, tax_amount, tax_input_amount)
    values
      (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '125',
       '125', '0', '125')`));
  await withBypassContext(() => db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${invoiceId} and org_id = ${org.orgId}`));
  await withBypassContext(() => postDocument(invoiceId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  }));
  return { orgId: org.orgId, profileId, invoiceId, date: org.date };
}

const post = (fx: Fx, scheduledFor: string) =>
  withOrgContext(state.orgId, () =>
    POST(
      new Request("http://collections.test/api/receipts/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paymentBankProfileId: fx.profileId,
          invoiceDocumentIds: [fx.invoiceId],
          scheduledFor,
        }),
      }),
    ),
  );

async function runCount(orgId: string): Promise<number> {
  const rows = (await withBypassContext(() =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from payment_runs where org_id = ${orgId}`))).rows;
  return rows[0]!.n;
}

test("collection run refuses a non-calendar scheduled date without writing", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const response = await post(fx, "2026-09-31");
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 400, `expected 400, got ${response.status}: ${JSON.stringify(json)}`);
    assert.doesNotMatch(json?.error ?? "", /invalid input syntax|Failed query/i);
    assert.equal(await runCount(fx.orgId), 0);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("collection run still starts on an ordinary scheduled date", { skip: !DB }, async () => {
  const fx = await fixture();
  try {
    const response = await post(fx, fx.date);
    assert.equal(response.status, 200, JSON.stringify(await response.json().catch(() => null)));
    assert.equal(await runCount(fx.orgId), 1);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
