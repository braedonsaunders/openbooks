import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, schema } from "./db.ts";

/**
 * Seed the openbooks DB from the NetSuite extraction: org, primary book,
 * monthly periods, the 336-account COA (type-mapped, hierarchy preserved,
 * NetSuite ids kept in custom.nsId for the replay), departments, parties.
 * Idempotent-ish: intended to run once against an empty database.
 */

const extraction = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extraction");
const readJson = (p: string) => JSON.parse(readFileSync(join(extraction, p), "utf8"));

const TYPE_MAP: Record<string, (typeof schema.ACCOUNT_TYPES)[number]> = {
  Bank: "asset_bank",
  AcctRec: "asset_receivable",
  OthCurrAsset: "asset_current_other",
  FixedAsset: "asset_fixed",
  OthAsset: "asset_other",
  AcctPay: "liability_payable",
  CredCard: "liability_card",
  OthCurrLiab: "liability_current_other",
  LongTermLiab: "liability_long_term",
  Equity: "equity",
  Income: "income",
  OthIncome: "income_other",
  COGS: "cogs",
  Expense: "expense",
  OthExpense: "expense_other",
  DeferExpense: "expense_deferred",
};

export async function seed() {
  const [org] = await db
    .insert(schema.orgs)
    .values({
      name: "Rassaun Services Inc",
      legalName: "Rassaun Services Inc.",
      baseCurrency: "CAD",
      country: "CA",
    })
    .returning();

  const [book] = await db
    .insert(schema.accountingBooks)
    .values({ orgId: org.id, code: "primary", name: "Primary Book", isPrimary: true })
    .returning();

  await db.insert(schema.currencies).values({ code: "CAD", name: "Canadian Dollar" }).onConflictDoNothing();

  // monthly periods 2015-01 .. 2027-12 (GL history starts 2018, opening balances earlier)
  const periods: (typeof schema.accountingPeriods.$inferInsert)[] = [];
  for (let y = 2015; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));
      periods.push({
        orgId: org.id,
        fiscalYear: y,
        periodNumber: m,
        name: `${y}-${String(m).padStart(2, "0")}`,
        startsOn: start.toISOString().slice(0, 10),
        endsOn: end.toISOString().slice(0, 10),
      });
    }
  }
  await db.insert(schema.accountingPeriods).values(periods);

  // departments (keep NS id for replay mapping)
  const departments = readJson("account-data/departments.json") as any[];
  for (const d of departments) {
    await db.insert(schema.departments).values({
      orgId: org.id,
      name: d.name ?? d.fullname ?? `Dept ${d.id}`,
      custom: { nsId: String(d.id) },
    });
  }

  // chart of accounts — two passes (parents may come after children in file)
  const coa = readJson("account-data/coa.json") as any[];
  const skipped: string[] = [];
  const idByNs = new Map<string, string>();
  for (const a of coa) {
    const type = TYPE_MAP[a.accttype];
    if (!type) {
      skipped.push(`${a.acctnumber ?? a.id} ${a.fullname} (${a.accttype})`);
      continue;
    }
    const [row] = await db
      .insert(schema.accounts)
      .values({
        orgId: org.id,
        number: a.acctnumber || null,
        name: a.accountsearchdisplaynamecopy ?? a.fullname ?? `Account ${a.id}`,
        type,
        isSummary: a.issummary === "T",
        isActive: a.isinactive !== "T",
        eliminate: a.eliminate === "T",
        reconcilable: a.reconcilewithmatching === "T",
        custom: { nsId: String(a.id), nsFullName: a.fullname, nsType: a.accttype },
      })
      .returning({ id: schema.accounts.id });
    idByNs.set(String(a.id), row.id);
  }
  // second pass: parents
  const { sql } = await import("drizzle-orm");
  for (const a of coa) {
    if (!a.parent || !idByNs.has(String(a.id)) || !idByNs.has(String(a.parent))) continue;
    await db.execute(sql`
      update accounts set parent_id = ${idByNs.get(String(a.parent))}
      where id = ${idByNs.get(String(a.id))}`);
  }

  // parties from NetSuite entities (customers, vendors, employees)
  const entities = readJson("gl-dump/entities.json") as any[];
  const BATCH = 500;
  for (let i = 0; i < entities.length; i += BATCH) {
    await db.insert(schema.parties).values(
      entities.slice(i, i + BATCH).map((e) => ({
        orgId: org.id,
        kind: e.kind === "employee" ? ("person" as const) : ("company" as const),
        displayName: String(e.name).slice(0, 500),
        custom: { nsId: String(e.id), nsEntityId: e.entityid, nsKind: e.kind },
      })),
    );
  }

  console.log(`org=${org.id}`);
  console.log(`book=${book.id}`);
  console.log(`periods=${periods.length} departments=${departments.length}`);
  console.log(`accounts=${idByNs.size} skipped=${skipped.length}`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  console.log(`parties=${entities.length}`);
}

seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
