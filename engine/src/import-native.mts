/**
 * NATIVE-TRANSACTION IMPORTER — the real cutover.
 *
 * Reads NetSuite NATIVE transactions (extraction/transactions/{headers,lines})
 * and, for every posting transaction, INSERTS an openbooks business document
 * (+ document_lines) then RE-POSTS it through the real posting engine
 * (postDocument → RULES → kernel), producing origin='document' journal
 * entries. Non-posting SalesOrd/PurchOrd become order documents (no GL).
 *
 * This is the counterpart of the proven dry-run engine/reconcile-native.mts:
 * it reuses that file's EXACT classification, sign, foreignamount and per-line
 * tax logic, but writes real rows instead of an in-memory trial balance.
 *
 * Tax: for each transaction we compute our engine's tax per code and compare
 * to NetSuite's ACTUAL tax (sum of taxline foreignamount). If they agree
 * (±$0.01) we post our computed tax (tax_overridden=false — engine validated).
 * If NetSuite hand-adjusted, we post NetSuite's actual tax (tax_overridden=true)
 * so the GL still matches to the cent.
 *
 * Idempotent: a transaction whose document (custom.nsId) already exists is
 * skipped. Per-transaction try/catch — one failure never aborts the run.
 *
 * Run (import all):        node_modules/.bin/tsx engine/src/import-native.mts
 * Run (sample N tids):     node_modules/.bin/tsx engine/src/import-native.mts --sample 50
 * Run (explicit tids):     node_modules/.bin/tsx engine/src/import-native.mts --tids 4452,4016
 */
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import { postDocument, type PostingDeps } from "./posting.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extraction");
const txnDir = join(root, "transactions");
const glDir = join(root, "gl-dump");

// -- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const sampleIdx = argv.indexOf("--sample");
const SAMPLE_N = sampleIdx >= 0 ? Number(argv[sampleIdx + 1]) : 0;
const tidsIdx = argv.indexOf("--tids");
const EXPLICIT_TIDS = tidsIdx >= 0 ? new Set((argv[tidsIdx + 1] ?? "").split(",").filter(Boolean)) : null;

// ---------------------------------------------------------------------------
// 0. Helpers (verbatim from reconcile-native.mts)
// ---------------------------------------------------------------------------
const round2 = (u: bigint): bigint => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const q = a / 100n;
  const rem = a % 100n;
  const r = rem >= 50n ? q + 1n : q;
  const cents = r * 100n;
  return neg ? -cents : cents;
};
const parseDate = (mmddyyyy: string): string => {
  const [m, d, y] = mmddyyyy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
};
async function* ndjson(file: string): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const s = line.trim();
    if (s) yield JSON.parse(s);
  }
}

// ---------------------------------------------------------------------------
// 1. Load mappings from DB
// ---------------------------------------------------------------------------
console.log("loading mappings from DB…");
const [org] = (await db.execute(sql`
  select id, base_currency, settings->'controlAccounts' as ctrl from orgs limit 1`)).rows as any[];
const ctrlRaw = org.ctrl as Record<string, string>;
const control: PostingDeps["control"] = {
  ar: ctrlRaw.ar,
  ap: ctrlRaw.ap,
  bank: ctrlRaw.bank,
  taxCollected: ctrlRaw.taxCollected,
  taxPaid: ctrlRaw.taxPaid,
  employeePayable: ctrlRaw.employeePayable,
};

const [book] = (await db.execute(sql`select id from accounting_books where is_primary = true limit 1`)).rows as any[];

const accountByNs = new Map<string, { id: string; number: string; name: string; type: string }>();
for (const r of (await db.execute(sql`
  select id, number, name, type, custom->>'nsId' ns from accounts where custom->>'nsId' is not null`)).rows as any[]) {
  accountByNs.set(r.ns, { id: r.id, number: r.number, name: r.name, type: r.type });
}
const acctInfoById = new Map<string, { number: string; name: string; ns: string }>();
for (const [ns, a] of accountByNs) acctInfoById.set(a.id, { number: a.number, name: a.name, ns });

const partyByNs = new Map<string, string>();
for (const r of (await db.execute(sql`
  select id, custom->>'nsId' ns from parties where custom->>'nsId' is not null`)).rows as any[])
  partyByNs.set(r.ns, r.id);

const deptByNs = new Map<string, string>();
for (const r of (await db.execute(sql`
  select id, custom->>'nsId' ns from departments where custom->>'nsId' is not null`)).rows as any[])
  deptByNs.set(r.ns, r.id);

const taxByRate = new Map<string, { id: string; rate: string }>();
for (const r of (await db.execute(sql`
  select tc.id, tc.custom->>'nsId' ns, tr.rate_percent rate from tax_codes tc
    left join tax_rates tr on tr.tax_code_id = tc.id`)).rows as any[]) {
  const rate = r.rate ?? "0";
  const key = String(Math.round(Number(rate)));
  if (!taxByRate.has(key)) taxByRate.set(key, { id: r.id, rate });
}

// periods by date (for a pre-flight period check; postDocument re-resolves it)
const periodList = (await db.execute(sql`
  select id, starts_on, ends_on from accounting_periods
   where org_id = ${org.id} and is_adjustment = false order by starts_on`)).rows as any[];
const periodFor = (d: string) => periodList.find((p) => p.starts_on <= d && p.ends_on >= d)?.id as string | undefined;

const arNs = acctInfoById.get(control.ar)?.ns;

console.log(
  `  accounts:${accountByNs.size} parties:${partyByNs.size} depts:${deptByNs.size} taxByRate:${taxByRate.size}`,
);

// ---------------------------------------------------------------------------
// 2. Applications set (to classify journal→customer_payment, report only)
// ---------------------------------------------------------------------------
const applications = JSON.parse(readFileSync(join(glDir, "applications.json"), "utf8")) as {
  payment_tid: string; applied_tid: string; amount: string;
}[];
const paymentTids = new Set(applications.map((a) => a.payment_tid));

// ---------------------------------------------------------------------------
// 3. Headers
// ---------------------------------------------------------------------------
type Header = {
  id: string; ttype: string; tranid?: string; trandate: string; duedate?: string;
  entity?: string; currency?: string; exchangerate?: string; postingperiod?: string;
  memo?: string; status?: string; posting?: string; otherrefnum?: string;
};
const headers = new Map<string, Header>();
for await (const h of ndjson(join(txnDir, "headers.ndjson"))) headers.set(h.id, h as Header);
console.log(`  headers: ${headers.size}`);

// ---------------------------------------------------------------------------
// 4. Classification (verbatim from reconcile-native.mts)
// ---------------------------------------------------------------------------
const NONPOSTING = new Set(["SalesOrd", "PurchOrd", "ItemShip"]);
const ORDER_KIND: Record<string, string> = { SalesOrd: "sales_order", PurchOrd: "purchase_order" };
const TTYPE_KIND: Record<string, string> = {
  VendBill: "vendor_bill", CustInvc: "customer_invoice", ExpRept: "expense_report",
  VendPymt: "vendor_payment", Check: "check", Transfer: "transfer",
  VendCred: "vendor_credit", CustCred: "customer_credit", CardChrg: "card_charge",
  CardRfnd: "card_refund",
};
const NEGATE_DETAIL = new Set(["customer_invoice", "vendor_credit"]);
const RULE_FOR_KIND: Record<string, string> = {
  vendor_bill: "vendor_bill", customer_invoice: "customer_invoice",
  expense_report: "expense_report", vendor_payment: "vendor_payment",
  check: "check", transfer: "transfer", vendor_credit: "vendor_credit",
  customer_credit: "customer_credit", card_charge: "card_charge",
  card_refund: "card_charge", journal: "journal", customer_payment: "customer_payment",
};

// ---------------------------------------------------------------------------
// 5. Line typing + amount/tax helpers (verbatim from reconcile-native.mts)
// ---------------------------------------------------------------------------
type RawLine = {
  transaction: string; id: string; mainline: string; taxline: string;
  account?: string; expenseaccount?: string; item?: string | null;
  netamount?: string; foreignamount?: string | null;
  taxrate1?: string | null; department?: string | null;
  entity?: string | null; memo?: string | null;
};

const glUnits = (l: RawLine): bigint =>
  toUnits((l.foreignamount != null && l.foreignamount !== "" ? l.foreignamount : l.netamount) ?? "0");

function lineTaxCode(l: RawLine): { codeId: string; rateUnits: bigint } | null {
  const tr = l.taxrate1;
  if (tr == null || tr === "") return null;
  const key = String(Math.round(Number(tr) * 100));
  const code = taxByRate.get(key);
  if (!code) return null;
  return { codeId: code.id, rateUnits: toUnits(code.rate) };
}
function taxOnBase(baseUnits: bigint, rateUnits: bigint): bigint {
  return round2((baseUnits * rateUnits) / (100n * 10000n));
}

// ---------------------------------------------------------------------------
// 6. Build the document row + document_lines for one transaction.
//    Mirrors reconcile-native.mts buildDoc but returns INSERT-ready shapes and
//    the native-tax override decision (tax_overridden per line).
// ---------------------------------------------------------------------------
interface DocRow {
  kind: string;
  partyId: string | null;
  documentDate: string;
  dueDate: string | null;
  memo: string | null;
  referenceNumber: string | null;
  controlAccountId: string | null;
}
interface LineRow {
  accountId: string;
  amount: string;
  taxAmount: string;
  taxOverridden: boolean;
  taxCodeId: string | null;
  departmentId: string | null;
  description: string | null;
  lineNumber: number;
}
interface Built {
  doc: DocRow;
  lines: LineRow[];
  effKind: string; // may be reclassified (e.g. no-AP vendor_payment → journal)
  taxComputedMatch: boolean; // true if our computed tax matched NS actual (or both zero)
}

function buildDoc(h: Header, rawLines: RawLine[], kind: string): Built | null {
  const partyId = h.entity ? partyByNs.get(h.entity) ?? null : null;
  const baseDoc: DocRow = {
    kind,
    partyId,
    documentDate: parseDate(h.trandate),
    dueDate: h.duedate ? parseDate(h.duedate) : null,
    memo: h.memo ?? null,
    referenceNumber: h.otherrefnum ?? h.tranid ?? null,
    controlAccountId: null,
  };

  // NetSuite's own actual tax total for this txn (sum of taxline GL amounts).
  let nsTaxUnits = 0n;
  for (const l of rawLines) if (l.taxline === "T") nsTaxUnits += glUnits(l);

  const negate = NEGATE_DETAIL.has(kind);
  const unmapped: string[] = [];
  const mkAcct = (l: RawLine): string | null => {
    const ns = l.expenseaccount ?? l.account;
    if (!ns) return null;
    const a = accountByNs.get(ns);
    if (!a) { unmapped.push(`acct:${ns}`); return null; }
    return a.id;
  };
  const dept = (l: RawLine): string | null =>
    l.department ? deptByNs.get(l.department) ?? null : null;

  const lines: LineRow[] = [];
  let ourTaxUnits = 0n;
  let lineNo = 0;
  let effKind = kind;

  const pushLine = (accountId: string, amtUnits: bigint, l: RawLine, taxCodeId: string | null = null): LineRow => {
    const row: LineRow = {
      accountId, amount: fromUnits(amtUnits), taxAmount: "0", taxOverridden: false,
      taxCodeId, departmentId: dept(l), description: l.memo ?? null, lineNumber: ++lineNo,
    };
    lines.push(row);
    return row;
  };

  if (kind === "journal") {
    for (const l of rawLines) {
      if (l.taxline === "T") continue;
      const acct = mkAcct(l);
      if (!acct) return null;
      pushLine(acct, glUnits(l), l);
    }
  } else if (kind === "transfer") {
    const glLines = rawLines.filter((l) => l.taxline !== "T").map((l) => ({ l, amt: glUnits(l) }));
    glLines.sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));
    const dest = glLines[0], src = glLines[glLines.length - 1];
    if (!dest || !src || dest === src) return null;
    const dAcct = mkAcct(dest.l), sAcct = mkAcct(src.l);
    if (!dAcct || !sAcct) return null;
    const mag = dest.amt < 0n ? -dest.amt : dest.amt;
    pushLine(dAcct, mag, dest.l);
    // second line amount 0 so rule total = |transfer|; postDocument drops zero lines
    // but the transfer rule uses lines[0]/lines[1] accountIds, so keep it.
    lines.push({
      accountId: sAcct, amount: "0", taxAmount: "0", taxOverridden: false, taxCodeId: null,
      departmentId: dept(src.l), description: src.l.memo ?? null, lineNumber: ++lineNo,
    });
  } else if (kind === "vendor_payment" || kind === "customer_payment") {
    const controlNs = kind === "vendor_payment" ? acctInfoById.get(control.ap)?.ns
                                                : acctInfoById.get(control.ar)?.ns;
    const nonTax = rawLines.filter((l) => l.taxline !== "T");
    const ctrlLine = nonTax.find((l) => (l.expenseaccount ?? l.account) === controlNs);
    if (!ctrlLine) {
      // no AP/AR leg → plain money movement → journal pass-through
      for (const l of nonTax) {
        const acct = mkAcct(l);
        if (!acct) return null;
        pushLine(acct, glUnits(l), l);
      }
      if (lines.length < 2) return null;
      effKind = "journal";
      return { doc: { ...baseDoc, kind: "journal" }, lines, effKind, taxComputedMatch: nsTaxUnits === 0n };
    }
    const bank = nonTax.find((l) => (l.expenseaccount ?? l.account) !== controlNs) ?? nonTax[0];
    if (!bank) return null;
    const acct = mkAcct(bank);
    if (!acct) return null;
    const totalUnits = glUnits(ctrlLine);
    pushLine(acct, totalUnits < 0n ? -totalUnits : totalUnits, bank);
  } else {
    // Standard document: detail lines (mainline='F' AND taxline='F').
    const detailRows: { row: LineRow; codeId: string | null }[] = [];
    const baseByCode = new Map<string, bigint>();
    const rateByCode = new Map<string, bigint>();
    for (const l of rawLines) {
      if (!(l.mainline === "F" && l.taxline === "F")) continue;
      const acct = mkAcct(l);
      if (!acct) return null;
      let amtUnits = glUnits(l);
      if (negate) amtUnits = -amtUnits;
      const tc = lineTaxCode(l);
      if (tc) {
        baseByCode.set(tc.codeId, (baseByCode.get(tc.codeId) ?? 0n) + amtUnits);
        rateByCode.set(tc.codeId, tc.rateUnits);
      }
      const row = pushLine(acct, amtUnits, l, tc?.codeId ?? null);
      detailRows.push({ row, codeId: tc?.codeId ?? null });
    }
    if (lines.length === 0) return null;

    // --- OUR engine's computed tax, rounded ONCE per code, on the first line
    //     carrying that code (mirrors reconcile-native.mts + taxLines()). ---
    const codeTax = new Map<string, bigint>();
    for (const [codeId, base] of baseByCode) {
      codeTax.set(codeId, taxOnBase(base, rateByCode.get(codeId) ?? 0n));
    }
    for (const t of codeTax.values()) ourTaxUnits += t;

    // --- NATIVE TAX OVERRIDE decision. Compare OUR total computed tax to
    //     NetSuite's ACTUAL total tax for the transaction. ---
    const ourAbs = ourTaxUnits < 0n ? -ourTaxUnits : ourTaxUnits;
    const nsAbs = nsTaxUnits < 0n ? -nsTaxUnits : nsTaxUnits;
    const bothZero = ourAbs === 0n && nsAbs === 0n;
    const within = ourAbs - nsAbs >= -100n && ourAbs - nsAbs <= 100n; // ±$0.01

    if (bothZero || within) {
      // engine validated → post OUR computed tax per code (tax_overridden=false)
      const assigned = new Set<string>();
      for (const { row, codeId } of detailRows) {
        if (!codeId || assigned.has(codeId)) continue;
        const t = codeTax.get(codeId) ?? 0n;
        if (t !== 0n) row.taxAmount = fromUnits(t);
        assigned.add(codeId);
      }
      return { doc: baseDoc, lines, effKind, taxComputedMatch: true };
    }

    // NetSuite hand-adjusted → post NetSuite's ACTUAL tax so the GL still
    // matches to the cent, flagged tax_overridden=true. We carry NS's actual
    // total on the first taxable line (its taxCodeId picks the correct
    // taxPaid/taxCollected control account); its sign follows our computed
    // magnitude so the rule's tax side lands right. If no line carried a code,
    // fall back to the first detail line with a rate.
    const carrier = detailRows.find((d) => d.codeId) ?? detailRows[0];
    if (carrier) {
      // NS taxline amount is stored on the sales/purchase-tax account already
      // in GL sign; the posting rule re-signs via taxLines(). Use |NS| as the
      // per-line tax magnitude (rule applies the correct sign per kind).
      carrier.row.taxAmount = fromUnits(nsAbs);
      carrier.row.taxOverridden = true;
      if (!carrier.row.taxCodeId) {
        // ensure a code so the rule routes tax to a control account; prefer 13%
        carrier.row.taxCodeId = taxByRate.get("13")?.id ?? taxByRate.get("5")?.id ?? null;
      }
    }
    return { doc: baseDoc, lines, effKind, taxComputedMatch: false };
  }

  if (lines.length === 0) return null;
  return { doc: baseDoc, lines, effKind, taxComputedMatch: nsTaxUnits === 0n };
}

// ---------------------------------------------------------------------------
// 7. Per-transaction control-account surfacing (mainline='T' control line).
// ---------------------------------------------------------------------------
function controlAccountFor(rawLines: RawLine[]): string | null {
  const ctrl = rawLines.find((l) => l.mainline === "T" && l.taxline === "F");
  if (!ctrl) return null;
  const ns = ctrl.expenseaccount ?? ctrl.account;
  return ns ? accountByNs.get(ns)?.id ?? null : null;
}

// ---------------------------------------------------------------------------
// 8. Deps (card liability fallback = AP; per-doc override wins in the rule).
// ---------------------------------------------------------------------------
const deps: PostingDeps = { control, cardLiabilityAccountId: control.ap };

// ---------------------------------------------------------------------------
// 9. Load already-imported nsIds (idempotency).
// ---------------------------------------------------------------------------
const existingNs = new Set<string>();
for (const r of (await db.execute(sql`select custom->>'nsId' ns from documents where custom->>'nsId' is not null`)).rows as any[])
  existingNs.add(r.ns);
console.log(`  already imported: ${existingNs.size} documents`);

// ---------------------------------------------------------------------------
// 10. Stream + group lines, then process each transaction.
// ---------------------------------------------------------------------------
console.log("streaming lines…");
const linesByTxn = new Map<string, RawLine[]>();
for await (const l of ndjson(join(txnDir, "lines.ndjson"))) {
  const rl = l as RawLine;
  const arr = linesByTxn.get(rl.transaction);
  if (arr) arr.push(rl);
  else linesByTxn.set(rl.transaction, [rl]);
}
for (const arr of linesByTxn.values()) arr.sort((a, b) => Number(a.id) - Number(b.id));

// stats
const byTypeStats = new Map<string, { imported: number; failed: number; skipped: number }>();
const bump = (t: string, k: "imported" | "failed" | "skipped") => {
  const s = byTypeStats.get(t) ?? { imported: 0, failed: 0, skipped: 0 };
  s[k]++; byTypeStats.set(t, s);
};
const failures: { tid: string; kind: string; reason: string }[] = [];
let docsCreated = 0, docLinesCreated = 0, entriesCreated = 0, ordersCreated = 0;
let taxComputedMatchCount = 0, taxOverrideCount = 0;
let skippedExisting = 0, skippedNonPosting = 0;
let processed = 0;

// order of transaction ids
let tids = [...linesByTxn.keys()];
if (EXPLICIT_TIDS) tids = tids.filter((t) => EXPLICIT_TIDS.has(t));
if (SAMPLE_N > 0) {
  // deterministic diverse sample: a spread across each posting ttype
  const wanted = SAMPLE_N;
  const perType = new Map<string, string[]>();
  for (const t of tids) {
    const h = headers.get(t);
    if (!h || h.posting !== "T" || NONPOSTING.has(h.ttype)) continue;
    const arr = perType.get(h.ttype) ?? [];
    if (arr.length < Math.ceil(wanted / 11)) arr.push(t);
    perType.set(h.ttype, arr);
  }
  tids = [...perType.values()].flat().slice(0, wanted);
  console.log(`SAMPLE MODE: ${tids.length} transactions across ${perType.size} types`);
}

// ---------------------------------------------------------------------------
// 11. Process one transaction: INSERT document + lines, then postDocument.
// ---------------------------------------------------------------------------
async function processTxn(tid: string): Promise<void> {
  const h = headers.get(tid);
  if (!h) return;
  const tt = h.ttype;
  const rawLines = linesByTxn.get(tid)!;

  // -- Non-posting orders: SalesOrd/PurchOrd → order docs; skip ItemShip. -----
  if (NONPOSTING.has(tt)) {
    const orderKind = ORDER_KIND[tt];
    if (!orderKind) { skippedNonPosting++; bump(tt, "skipped"); return; }
    if (existingNs.has(tid)) { skippedExisting++; bump(tt, "skipped"); return; }
    await importOrder(h, rawLines, orderKind);
    return;
  }
  // NetSuite only posts posting='T' to the GL.
  if (h.posting !== "T") { skippedNonPosting++; bump(tt, "skipped"); return; }

  if (existingNs.has(tid)) { skippedExisting++; bump(tt, "skipped"); return; }

  let kind = TTYPE_KIND[tt];
  if (tt === "Journal") kind = "journal";
  if (!kind) { skippedNonPosting++; bump(tt, "skipped"); return; }

  const built = buildDoc(h, rawLines, kind);
  if (!built) { failures.push({ tid, kind, reason: "build-failed/unmapped" }); bump(tt, "failed"); return; }
  const { doc, lines, effKind, taxComputedMatch } = built;

  // pre-flight: a period must cover the posting date (postDocument requires it)
  if (!periodFor(doc.documentDate)) {
    failures.push({ tid, kind, reason: `no period for ${doc.documentDate}` }); bump(tt, "failed"); return;
  }

  // per-transaction control-account override, stored ON the document so the
  // real posting rule reproduces NetSuite's header-chosen AP/AR/card account.
  const controlAccountId =
    (effKind === "vendor_bill" || effKind === "vendor_credit" || effKind === "expense_report" ||
      effKind === "customer_invoice" || effKind === "customer_credit" ||
      effKind === "card_charge" || effKind === "card_refund")
      ? controlAccountFor(rawLines)
      : null;

  let docId: string;
  try {
    docId = await db.transaction(async (tx) => {
      const [docRow] = await tx.insert(schema.documents).values({
        orgId: org.id,
        kind: effKind,
        documentNumber: tid, // NS transaction id — globally unique, idempotent
        partyId: doc.partyId,
        documentDate: doc.documentDate,
        dueDate: doc.dueDate,
        currency: "CAD",
        fxRate: "1",
        status: "approved", // ready to post
        memo: doc.memo,
        referenceNumber: doc.referenceNumber,
        custom: controlAccountId ? { nsId: tid, controlAccountId } : { nsId: tid },
      }).returning({ id: schema.documents.id });

      await tx.insert(schema.documentLines).values(
        lines.map((l) => ({
          orgId: org.id,
          documentId: docRow.id,
          lineNumber: l.lineNumber,
          accountId: l.accountId,
          amount: l.amount,
          taxCodeId: l.taxCodeId,
          taxAmount: l.taxAmount,
          taxOverridden: l.taxOverridden,
          departmentId: l.departmentId,
          description: l.description,
        })),
      );
      return docRow.id;
    });
    docsCreated++;
    docLinesCreated += lines.length;
  } catch (e: any) {
    failures.push({ tid, kind: effKind, reason: `insert:${(e?.message ?? String(e)).slice(0, 80)}` });
    bump(tt, "failed");
    return;
  }

  try {
    await postDocument(docId, deps);
    entriesCreated++;
    if (taxComputedMatch) taxComputedMatchCount++;
    if (lines.some((l) => l.taxOverridden)) taxOverrideCount++;
    existingNs.add(tid);
    bump(tt, "imported");
  } catch (e: any) {
    // posting failed — leave the (approved, unposted) document; report it.
    failures.push({ tid, kind: effKind, reason: `post:${(e?.message ?? String(e)).slice(0, 100)}` });
    bump(tt, "failed");
  }
}

async function importOrder(h: Header, rawLines: RawLine[], orderKind: string): Promise<void> {
  const partyId = h.entity ? partyByNs.get(h.entity) ?? null : null;
  const detail = rawLines.filter((l) => l.mainline === "F" && l.taxline === "F");
  const built: { accountId: string; amount: string; departmentId: string | null; description: string | null; lineNumber: number; taxCodeId: string | null }[] = [];
  let n = 0;
  for (const l of detail) {
    const ns = l.expenseaccount ?? l.account;
    const acct = ns ? accountByNs.get(ns)?.id : null;
    if (!acct) continue;
    const tc = lineTaxCode(l);
    built.push({
      accountId: acct,
      amount: fromUnits(glUnits(l)),
      departmentId: l.department ? deptByNs.get(l.department) ?? null : null,
      description: l.memo ?? null,
      lineNumber: ++n,
      taxCodeId: tc?.codeId ?? null,
    });
  }
  if (built.length === 0) { bump(h.ttype, "skipped"); skippedNonPosting++; return; }
  try {
    await db.transaction(async (tx) => {
      const [docRow] = await tx.insert(schema.documents).values({
        orgId: org.id,
        kind: orderKind,
        documentNumber: h.id,
        partyId,
        documentDate: parseDate(h.trandate),
        dueDate: h.duedate ? parseDate(h.duedate) : null,
        currency: "CAD",
        fxRate: "1",
        status: "approved",
        memo: h.memo ?? null,
        referenceNumber: h.otherrefnum ?? h.tranid ?? null,
        custom: { nsId: h.id },
      }).returning({ id: schema.documents.id });
      await tx.insert(schema.documentLines).values(
        built.map((l) => ({
          orgId: org.id,
          documentId: docRow.id,
          lineNumber: l.lineNumber,
          accountId: l.accountId,
          amount: l.amount,
          taxCodeId: l.taxCodeId,
          departmentId: l.departmentId,
          description: l.description,
        })),
      );
    });
    ordersCreated++;
    docsCreated++;
    docLinesCreated += built.length;
    existingNs.add(h.id);
    bump(h.ttype, "imported");
  } catch (e: any) {
    failures.push({ tid: h.id, kind: orderKind, reason: `order-insert:${(e?.message ?? String(e)).slice(0, 80)}` });
    bump(h.ttype, "failed");
  }
}

// ---------------------------------------------------------------------------
// 12. Run.
// ---------------------------------------------------------------------------
console.log(`processing ${tids.length} transactions…`);
const t0 = Date.now();
for (const tid of tids) {
  await processTxn(tid);
  processed++;
  if (processed % 2000 === 0) {
    const rate = (processed / ((Date.now() - t0) / 1000)).toFixed(0);
    console.log(`  ${processed}/${tids.length}  docs=${docsCreated} entries=${entriesCreated} orders=${ordersCreated} fails=${failures.length}  (${rate}/s)`);
  }
}

// ---------------------------------------------------------------------------
// 13. Report.
// ---------------------------------------------------------------------------
console.log("\n============ IMPORT SUMMARY ============");
console.log(`processed:            ${processed}`);
console.log(`documents created:    ${docsCreated}  (orders ${ordersCreated})`);
console.log(`document_lines:       ${docLinesCreated}`);
console.log(`journal entries:      ${entriesCreated}`);
console.log(`skipped (existing):   ${skippedExisting}`);
console.log(`skipped (nonposting): ${skippedNonPosting}`);
console.log(`tax computed-match:   ${taxComputedMatchCount}   tax overridden txns: ${taxOverrideCount}`);
console.log(`failures:             ${failures.length}`);
console.log("\nby type:");
for (const [t, s] of [...byTypeStats.entries()].sort())
  console.log(`   ${t.padEnd(10)} imported ${String(s.imported).padStart(6)}  failed ${String(s.failed).padStart(5)}  skipped ${String(s.skipped).padStart(5)}`);
if (failures.length) {
  console.log("\nFAILURE REASONS (top 20):");
  const byReason = new Map<string, number>();
  for (const f of failures) {
    const key = f.reason.replace(/[0-9a-f-]{8,}/g, "…");
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [r, c] of [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
    console.log(`   ${String(c).padStart(5)}  ${r}`);
  console.log("\nsample failing tids:", failures.slice(0, 15).map((f) => f.tid).join(", "));
}

await pool.end();
