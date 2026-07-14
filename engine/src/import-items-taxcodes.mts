import { readFileSync } from "node:fs";
import { db } from "./db.ts";
import { sql } from "drizzle-orm";

/**
 * Import NetSuite salestaxitem + taxgroup -> tax_codes (+ tax_rates), and
 * NetSuite item -> items. NetSuite ids stored in custom.nsId so the future
 * transaction importer can map by them.
 *
 * Tax mapping is reconciliation-critical: salestaxitem carries authoritative
 * saleaccount (collected) / purchaseaccount (paid). Transaction tax lines
 * reference taxGROUP ids (e.g. HST=2529), so we import taxgroups too, deriving
 * their accounts from the primary tax component (taxitem1).
 *
 * Idempotent: upsert by custom->>'nsId'. Safe to re-run.
 */

const salestaxitems = JSON.parse(readFileSync("/tmp/salestaxitem.json", "utf8")) as any[];
const taxgroups = JSON.parse(readFileSync("/tmp/taxgroup.json", "utf8")) as any[];
const items = JSON.parse(readFileSync("/tmp/items_raw.json", "utf8")) as any[];

const [u] = (
  await db.execute(sql`select id, org_id from users where email='bsaunders@rassaun.com'`)
).rows as any[];
const orgId = u.org_id as string;
const userId = u.id as string;

// Ensure tax_codes.custom column exists (schema declares it; live DB lacked it).
await db.execute(sql`ALTER TABLE tax_codes ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb`);

// NS account id -> openbooks account uuid
const acctRows = (
  await db.execute(sql`select id, custom->>'nsId' as ns from accounts where custom->>'nsId' is not null`)
).rows as any[];
const acctByNs = new Map<string, string>(acctRows.map((r) => [String(r.ns), r.id as string]));

// Fallback payable account: whatever the existing seeded tax_codes point at.
const [fallbackRow] = (
  await db.execute(
    sql`select collected_account_id from tax_codes where collected_account_id is not null limit 1`,
  )
).rows as any[];
const fallbackAccountId = fallbackRow?.collected_account_id as string | undefined;

const acctNumberById = new Map<string, string | null>(
  ((await db.execute(sql`select id, number from accounts`)).rows as any[]).map((r) => [
    r.id as string,
    r.number as string | null,
  ]),
);

function mapAcct(nsId: string | undefined | null): string | undefined {
  if (nsId == null || nsId === "") return undefined;
  return acctByNs.get(String(nsId));
}

// --- Build tax code definitions -------------------------------------------
// Each: nsId, kind (salestaxitem|taxgroup), code, name, rate (fraction),
//       collectedNs, paidNs
const stiById = new Map<string, any>(salestaxitems.map((s) => [String(s.id), s]));

type TaxDef = {
  nsId: string;
  nsKind: "salestaxitem" | "taxgroup";
  code: string;
  name: string;
  rate: number; // fraction 0.13
  collectedNs?: string;
  paidNs?: string;
};

const defs: TaxDef[] = [];

for (const s of salestaxitems) {
  defs.push({
    nsId: String(s.id),
    nsKind: "salestaxitem",
    code: String(s.itemid),
    name: String(s.description || s.itemid),
    rate: parseFloat(s.rate ?? "0") || 0,
    collectedNs: s.saleaccount != null ? String(s.saleaccount) : undefined,
    paidNs: s.purchaseaccount != null ? String(s.purchaseaccount) : undefined,
  });
}

for (const g of taxgroups) {
  // Derive accounts from the primary tax component (taxitem1), which is the
  // GST/HST component for CA groups; fall back to taxitem2.
  const comp = stiById.get(String(g.taxitem1)) ?? stiById.get(String(g.taxitem2));
  defs.push({
    nsId: String(g.id),
    nsKind: "taxgroup",
    code: String(g.itemid),
    name: String(g.description || g.itemid),
    rate: parseFloat(g.rate ?? "0") || 0,
    collectedNs: comp?.saleaccount != null ? String(comp.saleaccount) : undefined,
    paidNs: comp?.purchaseaccount != null ? String(comp.purchaseaccount) : undefined,
  });
}

// --- Upsert tax codes ------------------------------------------------------
const taxReport: {
  code: string;
  nsKind: string;
  rate: number;
  collectedAcct: string | null;
  paidAcct: string | null;
}[] = [];

for (const d of defs) {
  const collectedId = mapAcct(d.collectedNs) ?? fallbackAccountId ?? null;
  const paidId = mapAcct(d.paidNs) ?? fallbackAccountId ?? null;
  const custom = JSON.stringify({ nsId: d.nsId, nsRecord: d.nsKind });

  // Delete-then-insert by nsId for idempotency (also clears old tax_rates).
  const existing = (
    await db.execute(sql`select id from tax_codes where custom->>'nsId' = ${d.nsId}`)
  ).rows as any[];
  for (const e of existing) {
    await db.execute(sql`delete from tax_rates where tax_code_id = ${e.id}`);
    await db.execute(sql`delete from tax_codes where id = ${e.id}`);
  }

  // Avoid colliding on (org, code) with a non-nsId seeded row: if a seeded
  // tax_code shares this code and has no nsId, suffix ours.
  let code = d.code;
  const collide = (
    await db.execute(
      sql`select 1 from tax_codes where org_id=${orgId} and code=${code} and (custom->>'nsId') is distinct from ${d.nsId}`,
    )
  ).rows as any[];
  if (collide.length) code = `${d.code} [${d.nsKind === "taxgroup" ? "grp" : "sti"}:${d.nsId}]`;

  const [tc] = (
    await db.execute(sql`
      insert into tax_codes (org_id, code, name, country, applies_to, collected_account_id, paid_account_id, recoverable_percent, is_active, custom, created_by, updated_by)
      values (${orgId}, ${code}, ${d.name}, 'CA', 'both', ${collectedId}, ${paidId}, '100', true, ${custom}::jsonb, ${userId}, ${userId})
      returning id
    `)
  ).rows as any[];

  await db.execute(sql`
    insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
    values (${orgId}, ${tc.id}, ${String(d.rate * 100)}, '2015-01-01', ${userId}, ${userId})
  `);

  taxReport.push({
    code,
    nsKind: d.nsKind,
    rate: d.rate * 100,
    collectedAcct: collectedId ? acctNumberById.get(collectedId) ?? null : null,
    paidAcct: paidId ? acctNumberById.get(paidId) ?? null : null,
  });
}

// --- Items -----------------------------------------------------------------
const KIND_MAP: Record<string, string> = {
  Service: "service",
  NonInvtPart: "non_inventory",
  InvtPart: "inventory",
  Assembly: "assembly",
  Kit: "kit",
  OthCharge: "other_charge",
  Discount: "discount",
};
const SKIP = new Set(["Payment", "TaxItem", "SalesTaxItem", "Subtotal", "Description", "Group"]);

const kindCounts: Record<string, number> = {};
let itemsUpserted = 0;
let itemsSkipped = 0;
const unmappedTypes = new Set<string>();
const seenCodes = new Set<string>();

for (const it of items) {
  const nsType = String(it.itemtype ?? "");
  if (SKIP.has(nsType)) {
    itemsSkipped++;
    continue;
  }
  const kind = KIND_MAP[nsType] ?? "other_charge";
  if (!KIND_MAP[nsType]) unmappedTypes.add(nsType);

  const code = String(it.itemid);
  const name = String(it.displayname || it.itemid);
  const incomeId = mapAcct(it.incomeaccount) ?? null;
  const expenseId = mapAcct(it.expenseaccount) ?? null;
  const custom = JSON.stringify({ nsId: String(it.id), nsType });

  // Dedupe within this run on (org, code) — unique index items_org_code.
  if (seenCodes.has(code)) {
    itemsSkipped++;
    continue;
  }
  seenCodes.add(code);

  // Idempotent upsert by nsId; also respect unique (org, code).
  const byNs = (
    await db.execute(sql`select id from items where custom->>'nsId' = ${String(it.id)}`)
  ).rows as any[];
  if (byNs.length) {
    await db.execute(sql`
      update items set kind=${kind}, code=${code}, name=${name},
        income_account_id=${incomeId}, expense_account_id=${expenseId},
        is_active=true, custom=${custom}::jsonb, updated_by=${userId}, updated_at=now()
      where id=${byNs[0].id}
    `);
  } else {
    // Check (org, code) collision with a different nsId row.
    const codeClash = (
      await db.execute(
        sql`select id, custom->>'nsId' as ns from items where org_id=${orgId} and code=${code}`,
      )
    ).rows as any[];
    if (codeClash.length) {
      itemsSkipped++;
      continue; // don't create duplicate code
    }
    await db.execute(sql`
      insert into items (org_id, kind, code, name, income_account_id, expense_account_id, is_active, custom, created_by, updated_by)
      values (${orgId}, ${kind}, ${code}, ${name}, ${incomeId}, ${expenseId}, true, ${custom}::jsonb, ${userId}, ${userId})
    `);
  }
  itemsUpserted++;
  kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
}

// --- Report ----------------------------------------------------------------
console.log("\n===== TAX CODES =====");
console.log("imported (nsId-tagged):", taxReport.length);
console.table(taxReport);

console.log("\n===== ITEMS =====");
console.log("upserted:", itemsUpserted, " skipped:", itemsSkipped);
console.log("by kind:", kindCounts);
console.log("unmapped NS itemtypes -> other_charge:", [...unmappedTypes]);

const [{ tcc }] = (await db.execute(sql`select count(*)::int as tcc from tax_codes`)).rows as any[];
const [{ itc }] = (await db.execute(sql`select count(*)::int as itc from items`)).rows as any[];
console.log("\nTOTAL tax_codes:", tcc, " TOTAL items:", itc);

// Spot-check: HST taxgroup (2529) should be rate 13 and payable account 2100/collected side.
const hst = (
  await db.execute(sql`
    select t.code, t.custom->>'nsId' as nsid, r.rate_percent,
      ca.number as collected_num, pa.number as paid_num
    from tax_codes t
    left join tax_rates r on r.tax_code_id=t.id
    left join accounts ca on ca.id=t.collected_account_id
    left join accounts pa on pa.id=t.paid_account_id
    where t.custom->>'nsId' in ('2529','2525')
    order by t.custom->>'nsId'
  `)
).rows as any[];
console.log("\nHST spot-check (nsId 2525 salestaxitem, 2529 taxgroup):");
console.table(hst);

process.exit(0);
