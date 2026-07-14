/**
 * NATIVE-TRANSACTION IMPORTER + DRY-RUN TRIAL-BALANCE RECONCILIATION.
 *
 * Proves that importing NetSuite NATIVE transactions (headers + lines) and
 * re-deriving their GL through OUR posting engine (RULES) + OUR tax engine
 * reproduces NetSuite's own trial balance to the cent — WITHOUT writing a
 * single row to journal_entries / journal_lines / documents.
 *
 * Pure dry-run: we build in-memory Doc / DocLine objects, run RULES[kind],
 * aggregate the kernel lines into a trial balance, and diff vs tb-netsuite.json.
 *
 * Run:  node_modules/.bin/tsx engine/reconcile-native.mts
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db, pool, schema } from "./src/db.ts";
import { fromUnits, toUnits } from "./src/money.ts";
import { RULES, type PostingDeps } from "./src/posting.ts";

type Doc = typeof schema.documents.$inferSelect;
type DocLine = typeof schema.documentLines.$inferSelect;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "extraction");
const txnDir = join(root, "transactions");
const glDir = join(root, "gl-dump");

// ---------------------------------------------------------------------------
// 0. Helpers
// ---------------------------------------------------------------------------
const round2 = (u: bigint): bigint => {
  // round to cents (2 dp) on the 1e4-scaled bigint; half-away-from-zero
  const neg = u < 0n;
  const a = neg ? -u : u;
  const q = a / 100n;
  const rem = a % 100n;
  const r = rem >= 50n ? q + 1n : q;
  const cents = r * 100n; // back to 1e4 scale, cents-precise
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
  employeePayable: ctrlRaw.employeePayable, // may be undefined → rule falls back to ap
};

const accountByNs = new Map<string, { id: string; number: string; name: string; type: string }>();
for (const r of (await db.execute(sql`
  select id, number, name, type, custom->>'nsId' ns from accounts where custom->>'nsId' is not null`)).rows as any[]) {
  accountByNs.set(r.ns, { id: r.id, number: r.number, name: r.name, type: r.type });
}
// reverse: accountId -> ns number/name (for reporting)
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

// tax codes: nsId -> {id, ratePercent}; plus a rate-indexed fallback (rate string like "13" -> code)
const taxByNs = new Map<string, { id: string; rate: string }>();
const taxByRate = new Map<string, { id: string; rate: string }>();
for (const r of (await db.execute(sql`
  select tc.id, tc.custom->>'nsId' ns, tr.rate_percent rate from tax_codes tc
    left join tax_rates tr on tr.tax_code_id = tc.id`)).rows as any[]) {
  const rate = r.rate ?? "0";
  if (r.ns) taxByNs.set(r.ns, { id: r.id, rate });
  // index by whole-number rate for fallback (prefer first seen)
  const key = String(Math.round(Number(rate)));
  if (!taxByRate.has(key)) taxByRate.set(key, { id: r.id, rate });
}

// AR account nsId (to detect "journal credits AR")
const arNs = acctInfoById.get(control.ar)?.ns; // "119"

console.log(
  `  accounts:${accountByNs.size} parties:${partyByNs.size} depts:${deptByNs.size} taxCodes(byNs):${taxByNs.size}`,
);

// ---------------------------------------------------------------------------
// 2. Applications: which tids are payment_tid (a payment applies to something)
// ---------------------------------------------------------------------------
const applications = JSON.parse(readFileSync(join(glDir, "applications.json"), "utf8")) as {
  payment_tid: string;
  applied_tid: string;
  amount: string;
}[];
const paymentTids = new Set(applications.map((a) => a.payment_tid));

// The set of transaction ids present in NetSuite's GL snapshot (gl.ndjson). The
// TB ground truth (tb-netsuite.json) was extracted from the same snapshot. A few
// transactions in the newer transaction extract postdate that snapshot (dated
// 2026-07-14/15 vs the GL cutoff 2026-07-13) and have NO ground-truth GL — we
// exclude them so the comparison is apples-to-apples (they'd otherwise inject
// phantom deltas into bank/AR/sales). Reported separately as "post-snapshot".
const glTids = new Set<string>();
for await (const g of ndjson(join(glDir, "gl.ndjson"))) glTids.add(g.tid as string);

// ---------------------------------------------------------------------------
// 3. Headers
// ---------------------------------------------------------------------------
type Header = {
  id: string; ttype: string; tranid: string; trandate: string; duedate?: string;
  entity?: string; currency?: string; exchangerate?: string; postingperiod?: string;
  memo?: string; status?: string; posting?: string;
};
const headers = new Map<string, Header>();
for await (const h of ndjson(join(txnDir, "headers.ndjson"))) headers.set(h.id, h as Header);
console.log(`  headers: ${headers.size}`);

// ---------------------------------------------------------------------------
// 4. Classification
// ---------------------------------------------------------------------------
const NONPOSTING = new Set(["SalesOrd", "PurchOrd", "ItemShip"]);
const TTYPE_KIND: Record<string, string> = {
  VendBill: "vendor_bill", CustInvc: "customer_invoice", ExpRept: "expense_report",
  VendPymt: "vendor_payment", Check: "check", Transfer: "transfer",
  VendCred: "vendor_credit", CustCred: "customer_credit", CardChrg: "card_charge",
  CardRfnd: "card_refund",
};

// Line-building strategy per kind:
//  - detail lines = mainline='F' AND taxline='F'
//  - EXCEPT journal/transfer/vendor_payment/customer_payment which are driven off
//    the transaction's own signed lines (see buildLines).
//
// Sign normalization (verified against gl.ndjson):
//   vendor_bill / expense_report / card_charge / check : detail netamount passed AS-IS
//     (rule debits l.amount; NetSuite netamount already +expense).
//   customer_invoice / customer_credit / vendor_credit / card_refund : detail
//     netamount NEGATED (rule expects a positive magnitude; NetSuite stores the
//     income/credit side as −netamount).
// Verified per-type against gl.ndjson:
//   customer_invoice: NS detail netamount is −income → negate to +magnitude so the
//     invoice rule's neg(l.amount) credits income & debits AR.
//   vendor_credit:    NS detail netamount is −expense → negate to +magnitude so the
//     credit rule's neg(l.amount) credits expense & debits AP.
//   customer_credit:  NS detail netamount is ALREADY +income → pass AS-IS (rule
//     debits income l.amount, credits AR). Do NOT negate.
//   card_refund:      NS detail netamount is −expense; pass AS-IS through the
//     card_charge rule so it credits expense (amount<0) and debits the card.
const NEGATE_DETAIL = new Set(["customer_invoice", "vendor_credit"]);

// card_refund has no dedicated rule; it is the reverse of card_charge. We map it
// to customer_credit-style? No — it credits an expense / debits the card refund.
// Simplest faithful path: treat card_refund via the `card_charge` rule with
// negated detail (so expense is credited, card debited). We reuse card_charge.
const RULE_FOR_KIND: Record<string, string> = {
  vendor_bill: "vendor_bill", customer_invoice: "customer_invoice",
  expense_report: "expense_report", vendor_payment: "vendor_payment",
  check: "check", transfer: "transfer", vendor_credit: "vendor_credit",
  customer_credit: "customer_credit", card_charge: "card_charge",
  card_refund: "card_charge", // reverse handled by NEGATE_DETAIL
  journal: "journal", customer_payment: "customer_payment",
};

// ---------------------------------------------------------------------------
// 5. Group lines by transaction (single streaming pass), then build & post.
// ---------------------------------------------------------------------------
type RawLine = {
  transaction: string; id: string; mainline: string; taxline: string;
  account?: string; expenseaccount?: string; item?: string | null;
  netamount?: string; foreignamount?: string | null;
  taxrate1?: string | null; department?: string | null;
  entity?: string | null; memo?: string | null;
};

// The base-currency amount NetSuite actually posted to the GL is `foreignamount`
// (verified: it matches gl.ndjson on 67,133/67,136 detail lines vs 65,989 for
// netamount — netamount diverges on billable-markup / reclassified lines). Use
// foreignamount as the posting amount; fall back to netamount only if absent.
const glUnits = (l: RawLine): bigint =>
  toUnits((l.foreignamount != null && l.foreignamount !== "" ? l.foreignamount : l.netamount) ?? "0");

// Resolve OUR tax code for a detail line from its effective per-line rate
// (taxrate1), matched to a code in OUR tax_codes table. A 0-rate / exempt line
// resolves to a 0% code → contributes $0 tax. Returns the code id + its 1e4-
// scaled rate_percent (e.g. 13% → 130000).
function lineTaxCode(l: RawLine): { codeId: string; rateUnits: bigint } | null {
  const tr = l.taxrate1;
  if (tr == null || tr === "") return null;
  const key = String(Math.round(Number(tr) * 100)); // 0.13 → "13"
  const code = taxByRate.get(key);
  if (!code) return null;
  return { codeId: code.id, rateUnits: toUnits(code.rate) };
}

// OUR tax engine — the tax on a taxable base = round(base × rate_percent/100, 2),
// computed on the SIGNED base PER TAX CODE and rounded ONCE per code (matching
// NetSuite: a line and its reversal at the same rate net their tax before
// rounding). base & result are 1e4-scaled bigints.
function taxOnBase(baseUnits: bigint, rateUnits: bigint): bigint {
  return round2((baseUnits * rateUnits) / (100n * 10000n));
}

// Build the in-memory Doc + DocLines for one transaction. Returns null if the
// kind is unhandled. Also returns nsTaxUnits = sum of NetSuite taxline netamounts.
type Built = {
  doc: Doc; lines: DocLine[]; ourTaxUnits: bigint; nsTaxUnits: bigint;
  unmapped: string[]; controlAccountId?: string | null;
};
function buildDoc(h: Header, rawLines: RawLine[], kind: string): Built | null {
  const unmapped: string[] = [];
  const partyId = h.entity ? partyByNs.get(h.entity) ?? null : null;
  const doc = {
    kind,
    partyId,
    documentDate: parseDate(h.trandate),
    dueDate: h.duedate ? parseDate(h.duedate) : null,
    currency: "CAD",
    fxRate: "1",
    departmentId: null,
    projectId: null,
    locationId: null,
    classId: null,
    paymentCardId: null,
    memo: h.memo ?? null,
    orgId: org.id,
  } as unknown as Doc;

  // NetSuite's own tax total for this txn (sum of taxline GL amounts).
  let nsTaxUnits = 0n;
  for (const l of rawLines) if (l.taxline === "T") nsTaxUnits += glUnits(l);

  const negate = NEGATE_DETAIL.has(kind);
  const mkAcct = (l: RawLine): string | null => {
    const ns = l.expenseaccount ?? l.account;
    if (!ns) return null;
    const a = accountByNs.get(ns);
    if (!a) { unmapped.push(`acct:${ns}`); return null; }
    return a.id;
  };
  const dept = (l: RawLine): string | null =>
    l.department ? deptByNs.get(l.department) ?? null : null;

  const lines: DocLine[] = [];
  let ourTaxUnits = 0n;
  let lineNo = 0;

  if (kind === "journal") {
    // Journals: every non-tax line is a GL line. GL signed amount = +netamount
    // (verified vs gl.ndjson: netamount + → debit, netamount − → credit).
    for (const l of rawLines) {
      if (l.taxline === "T") continue;
      const acct = mkAcct(l);
      if (!acct) return null;
      const amtUnits = glUnits(l); // signed +DR/−CR
      lines.push({
        accountId: acct,
        amount: fromUnits(amtUnits),
        taxAmount: "0",
        taxCodeId: null,
        departmentId: dept(l),
        projectId: null, locationId: null, classId: null,
        description: l.memo ?? null,
        lineNumber: ++lineNo,
      } as unknown as DocLine);
    }
  } else if (kind === "transfer") {
    // Transfer GL = netamount as-is (+DR / −CR). The transfer rule DRs lines[0],
    // CRs lines[1], by total=sum(amounts). So: line0 = destination (+netamount)
    // with amount = |transfer|; line1 = source (−netamount) with amount 0 (so
    // total stays = |transfer|). Reproduces DR dest / CR source exactly.
    const glLines = rawLines
      .filter((l) => l.taxline !== "T")
      .map((l) => ({ l, amt: glUnits(l) }));
    glLines.sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0)); // dest(+) first
    const dest = glLines[0], src = glLines[glLines.length - 1];
    if (!dest || !src || dest === src) return null;
    const dAcct = mkAcct(dest.l), sAcct = mkAcct(src.l);
    if (!dAcct || !sAcct) return null;
    const mag = dest.amt < 0n ? -dest.amt : dest.amt;
    lines.push({
      accountId: dAcct, amount: fromUnits(mag), taxAmount: "0", taxCodeId: null,
      departmentId: dept(dest.l), projectId: null, locationId: null, classId: null,
      description: dest.l.memo ?? null, lineNumber: ++lineNo,
    } as unknown as DocLine);
    lines.push({
      accountId: sAcct, amount: "0", taxAmount: "0", taxCodeId: null,
      departmentId: dept(src.l), projectId: null, locationId: null, classId: null,
      description: src.l.memo ?? null, lineNumber: ++lineNo,
    } as unknown as DocLine);
  } else if (kind === "vendor_payment" || kind === "customer_payment") {
    // VendPymt has two lines: one hits the AP/AR control account (ns 111 / 119),
    // the other is the bank/clearing account the money moved through. The
    // vendor_payment rule DRs control.ap by `total` and CRs lines[0].accountId
    // (the bank leg) by neg(total). So lines[0] MUST be the *non-control* (bank)
    // leg. Pick the leg whose account is NOT the AP/AR control account.
    const controlNs = kind === "vendor_payment" ? acctInfoById.get(control.ap)?.ns
                                                 : acctInfoById.get(control.ar)?.ns;
    const nonTax = rawLines.filter((l) => l.taxline !== "T");
    const ctrlLine = nonTax.find((l) => (l.expenseaccount ?? l.account) === controlNs);
    if (!ctrlLine) {
      // No AP/AR leg → this "VendPymt" is a plain 2-account money movement
      // (e.g. a Ford-Credit loan draw: DR clearing / CR bank). NetSuite GL sign
      // = netamount as-is; post it through the journal pass-through rule.
      for (const l of nonTax) {
        const acct = mkAcct(l);
        if (!acct) return null;
        lines.push({
          accountId: acct, amount: fromUnits(glUnits(l)), taxAmount: "0",
          taxCodeId: null, departmentId: dept(l), projectId: null, locationId: null,
          classId: null, description: l.memo ?? null, lineNumber: ++lineNo,
        } as unknown as DocLine);
      }
      if (lines.length < 2) return null;
      return { doc: { ...doc, kind: "journal" } as Doc, lines, ourTaxUnits: 0n, nsTaxUnits, unmapped };
    }
    const bank = nonTax.find((l) => (l.expenseaccount ?? l.account) !== controlNs) ?? nonTax[0];
    if (!bank) return null;
    const acct = mkAcct(bank);
    if (!acct) return null;
    // magnitude = |GL amount| of the control (AP/AR) leg = the amount cleared.
    const totalUnits = glUnits(ctrlLine ?? bank);
    lines.push({
      accountId: acct, amount: fromUnits(totalUnits < 0n ? -totalUnits : totalUnits),
      taxAmount: "0", taxCodeId: null, departmentId: dept(bank),
      projectId: null, locationId: null, classId: null,
      description: bank.memo ?? null, lineNumber: ++lineNo,
    } as unknown as DocLine);
  } else {
    // Standard document: detail lines (mainline='F' AND taxline='F').
    // Pass 1 — build lines, remember each line's tax code + accumulate the
    // SIGNED taxable base per tax code (a line and its reversal net out).
    const lineIdx: number[] = []; // index into `lines` for each built detail line
    const lineCode: (string | null)[] = [];
    const baseByCode = new Map<string, bigint>(); // codeId → signed base (1e4)
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
      lineIdx.push(lines.length);
      lineCode.push(tc?.codeId ?? null);
      lines.push({
        accountId: acct,
        amount: fromUnits(amtUnits),
        taxAmount: "0",
        taxCodeId: tc?.codeId ?? null,
        departmentId: dept(l),
        projectId: null, locationId: null, classId: null,
        description: l.memo ?? null,
        lineNumber: ++lineNo,
      } as unknown as DocLine);
    }
    // Pass 2 — round the tax ONCE per code (on the signed base), then attach the
    // whole code's tax to the first line carrying that code. taxLines() in the
    // posting rules groups by code and sums, so the grouped total is exact.
    const codeTaxAssigned = new Set<string>();
    for (let i = 0; i < lineIdx.length; i++) {
      const codeId = lineCode[i];
      if (!codeId || codeTaxAssigned.has(codeId)) continue;
      const base = baseByCode.get(codeId) ?? 0n;
      const taxUnits = taxOnBase(base, rateByCode.get(codeId) ?? 0n);
      if (taxUnits !== 0n) {
        (lines[lineIdx[i]!] as unknown as { taxAmount: string }).taxAmount = fromUnits(taxUnits);
        ourTaxUnits += taxUnits;
      }
      codeTaxAssigned.add(codeId);
    }
  }

  if (lines.length === 0) return null;

  // The AP/AR control account NetSuite actually used is the mainline='T' control
  // line's account (usually 111/119 but sometimes a financing account like 868).
  // We surface it so processTxn can point deps.control.ap/ar at it, reproducing
  // NetSuite's header-chosen payable/receivable account through the real rule.
  let controlAccountId: string | null = null;
  const ctrl = rawLines.find((l) => l.mainline === "T" && l.taxline === "F");
  if (ctrl) {
    const ns = ctrl.expenseaccount ?? ctrl.account;
    if (ns) controlAccountId = accountByNs.get(ns)?.id ?? null;
  }
  return { doc, lines, ourTaxUnits, nsTaxUnits, unmapped, controlAccountId };
}

// ---------------------------------------------------------------------------
// 6. Stream lines.ndjson, group by transaction, process each.
// ---------------------------------------------------------------------------
console.log("streaming lines + reconciling…");

// The org's control accounts collapse purchase & sales tax onto one account
// (taxPaid == taxCollected == ns 212 / acct 2100). NetSuite keeps them separate:
// purchase-side (recoverable ITC) → ns 210 (acct 1200 "GST/HST on Purchases"),
// sales-side → ns 212 (acct 2100 "GST/HST Payable"). Point taxPaid at ns 210 so
// the real rules route purchase tax to the account NetSuite uses. (Dry-run
// config only — orgs.settings is NOT modified.)
const purchaseTaxAcct = accountByNs.get("210")?.id;
const control2: PostingDeps["control"] = purchaseTaxAcct
  ? { ...control, taxPaid: purchaseTaxAcct }
  : control;

// deps with a card liability fallback: card docs need cardLiabilityAccountId.
// We resolve a single card-liability control account = AP fallback (v1: report).
const deps: PostingDeps = { control: control2, cardLiabilityAccountId: control2.ap };

const ourTb = new Map<string, bigint>(); // accountId → signed sum (1e4)
const byTypeStats = new Map<string, { imported: number; failed: number; skipped: number }>();
const bump = (t: string, k: "imported" | "failed" | "skipped") => {
  const s = byTypeStats.get(t) ?? { imported: 0, failed: 0, skipped: 0 };
  s[k]++; byTypeStats.set(t, s);
};
const ruleFailReasons = new Map<string, number>();
const failReason = (r: string) => ruleFailReasons.set(r, (ruleFailReasons.get(r) ?? 0) + 1);

let taxMatch = 0, taxMismatch = 0, taxZeroBoth = 0;
let classifiedCustPayments = 0;
let nonPostingSkipped = 0;
let postSnapshotSkipped = 0;

function processTxn(tid: string, rawLines: RawLine[]) {
  const h = headers.get(tid);
  if (!h) return;
  const tt = h.ttype;
  if (NONPOSTING.has(tt)) { nonPostingSkipped++; bump(tt, "skipped"); return; }

  // NetSuite only posts transactions flagged posting='T' to the GL. Non-posting
  // records (unapproved/void memos, e.g. the "close internal billing" journal)
  // exist as transactionlines but never hit the ledger — exclude them, exactly
  // as NetSuite does, or they inflate our TB.
  if (h.posting !== "T") { nonPostingSkipped++; bump(tt, "skipped"); return; }

  // Exclude transactions newer than the GL/TB snapshot (no ground truth to
  // reconcile against). Keeps the comparison apples-to-apples.
  if (!glTids.has(tid)) { postSnapshotSkipped++; bump(tt, "skipped"); return; }

  let kind = TTYPE_KIND[tt];
  if (tt === "Journal") {
    // classify: applied-to-invoice payment that credits AR → customer_payment
    // (report only; GL still derived via journal pass-through for fidelity).
    kind = "journal";
    if (paymentTids.has(tid) && arNs) {
      const creditsAr = rawLines.some(
        (l) => l.taxline !== "T" && (l.account === arNs || l.expenseaccount === arNs) &&
          glUnits(l) < 0n, // GL credit = negative signed
      );
      if (creditsAr) classifiedCustPayments++;
    }
  }
  if (!kind) { bump(tt, "skipped"); return; }

  const built = buildDoc(h, rawLines, kind);
  if (!built) { failReason(`build-failed/unmapped (${kind})`); bump(tt, "failed"); return; }
  const { doc, lines, ourTaxUnits, nsTaxUnits, controlAccountId } = built;

  // Per-transaction control override: point AP (for vendor bills/credits/expense
  // reports) or AR (for customer invoices/credits) at the account NetSuite chose
  // on the header, when it differs from the org default.
  let txnDeps = deps;
  if (controlAccountId) {
    if (kind === "vendor_bill" || kind === "vendor_credit" || kind === "expense_report")
      txnDeps = { ...deps, control: { ...deps.control, ap: controlAccountId } };
    else if (kind === "customer_invoice" || kind === "customer_credit")
      txnDeps = { ...deps, control: { ...deps.control, ar: controlAccountId } };
    else if (kind === "card_charge" || kind === "card_refund")
      // The card's liability/clearing account is the header (mainline='T') control
      // line — a per-card 2200.xx / employee subaccount, not a blanket AP.
      txnDeps = { ...deps, cardLiabilityAccountId: controlAccountId };
  }

  // tax validation
  const ourT = ourTaxUnits < 0n ? -ourTaxUnits : ourTaxUnits;
  const nsT = nsTaxUnits < 0n ? -nsTaxUnits : nsTaxUnits;
  if (ourT === 0n && nsT === 0n) taxZeroBoth++;
  else if ((ourT - nsT >= -100n && ourT - nsT <= 100n)) taxMatch++; // within $0.01
  else taxMismatch++;

  // buildDoc may reclassify (e.g. a no-AP "VendPymt" → journal). Follow doc.kind.
  const effKind = (doc.kind as string) || kind;
  const ruleName = RULE_FOR_KIND[effKind] ?? effKind;
  const rule = RULES[ruleName];
  if (!rule) { failReason(`no rule for ${ruleName}`); bump(tt, "failed"); return; }

  let kernel;
  try {
    kernel = rule(doc, lines, txnDeps);
  } catch (e: any) {
    failReason(`throw:${(e?.message ?? String(e)).slice(0, 60)}`);
    bump(tt, "failed");
    return;
  }

  // balance check
  let bal = 0n;
  for (const kl of kernel) bal += toUnits(kl.amount);
  if (bal !== 0n) { failReason(`unbalanced (${kind}) Δ${fromUnits(bal)}`); bump(tt, "failed"); return; }

  for (const kl of kernel) {
    if (!kl.accountId) continue;
    ourTb.set(kl.accountId, (ourTb.get(kl.accountId) ?? 0n) + toUnits(kl.amount));
  }
  bump(tt, "imported");
}

// lines.ndjson is NOT grouped by transaction — buffer all lines per tid first.
const linesByTxn = new Map<string, RawLine[]>();
for await (const l of ndjson(join(txnDir, "lines.ndjson"))) {
  const rl = l as RawLine;
  const arr = linesByTxn.get(rl.transaction);
  if (arr) arr.push(rl);
  else linesByTxn.set(rl.transaction, [rl]);
}
// preserve line order within a txn by id (numeric) for deterministic rule input.
for (const [tid, arr] of linesByTxn) {
  arr.sort((a, b) => Number(a.id) - Number(b.id));
  processTxn(tid, arr);
}

// ---------------------------------------------------------------------------
// 7. Load NetSuite TB and compare.
// ---------------------------------------------------------------------------
const nsRaw = JSON.parse(readFileSync(join(glDir, "tb-netsuite.json"), "utf8")) as {
  acct?: string; d: string; c: string;
}[];
const nsTb = new Map<string, bigint>(); // accountNs → signed (d−c)
for (const r of nsRaw) {
  if (!r.acct) continue;
  nsTb.set(String(r.acct), toUnits(r.d) - toUnits(r.c));
}

// our TB keyed by account nsId
const ourByNs = new Map<string, bigint>();
for (const [acctId, bal] of ourTb) {
  const info = acctInfoById.get(acctId);
  if (!info) continue;
  ourByNs.set(info.ns, (ourByNs.get(info.ns) ?? 0n) + bal);
}

const allNs = new Set<string>([...nsTb.keys(), ...ourByNs.keys()]);
let matched = 0;
const mismatches: { ns: string; number: string; name: string; ours: bigint; ns_bal: bigint; delta: bigint }[] = [];
let totalAbsDelta = 0n;
for (const ns of allNs) {
  const ours = ourByNs.get(ns) ?? 0n;
  const theirs = nsTb.get(ns) ?? 0n;
  const delta = ours - theirs;
  const absd = delta < 0n ? -delta : delta;
  if (absd <= 100n) matched++; // within $0.01
  else {
    const acc = accountByNs.get(ns);
    mismatches.push({
      ns, number: acc?.number ?? "?", name: acc?.name ?? `ns:${ns}`,
      ours, ns_bal: theirs, delta,
    });
    totalAbsDelta += absd;
  }
}
mismatches.sort((a, b) => {
  const da = a.delta < 0n ? -a.delta : a.delta;
  const db_ = b.delta < 0n ? -b.delta : b.delta;
  return db_ > da ? 1 : db_ < da ? -1 : 0;
});

// ---------------------------------------------------------------------------
// 8. Report
// ---------------------------------------------------------------------------
const totalImported = [...byTypeStats.values()].reduce((a, s) => a + s.imported, 0);
const totalFailed = [...byTypeStats.values()].reduce((a, s) => a + s.failed, 0);
const totalSkipped = [...byTypeStats.values()].reduce((a, s) => a + s.skipped, 0);
const taxDenom = taxMatch + taxMismatch;
const taxRate = taxDenom ? ((taxMatch / taxDenom) * 100).toFixed(2) : "n/a";

const report = {
  generatedAt: new Date().toISOString(),
  note: "DRY RUN — no writes to journal_entries/journal_lines/documents. GL re-derived via posting.ts RULES + native tax engine.",
  totals: {
    transactionsWithLines: headers.size,
    imported: totalImported,
    ruleFailed: totalFailed,
    skippedNonPosting: totalSkipped,
    skippedPostSnapshot: postSnapshotSkipped,
    classifiedCustomerPaymentsFromJournals: classifiedCustPayments,
  },
  byType: Object.fromEntries(
    [...byTypeStats.entries()].sort().map(([t, s]) => [t, s]),
  ),
  taxEngine: {
    matchesWithin1Cent: taxMatch,
    mismatches: taxMismatch,
    bothZero: taxZeroBoth,
    matchRatePct: taxRate,
  },
  trialBalance: {
    accountsCompared: allNs.size,
    matchedWithin1Cent: matched,
    mismatched: mismatches.length,
    totalAbsoluteDelta: fromUnits(totalAbsDelta),
    top20Mismatches: mismatches.slice(0, 20).map((m) => ({
      account: m.number, name: m.name, nsId: m.ns,
      ours: fromUnits(m.ours), netsuite: fromUnits(m.ns_bal), delta: fromUnits(m.delta),
    })),
  },
  topRuleFailureReasons: [...ruleFailReasons.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([reason, count]) => ({ reason, count })),
};

writeFileSync(join(root, "reconciliation-report.json"), JSON.stringify(report, null, 2));

// -- console summary --------------------------------------------------------
console.log("\n============ RECONCILIATION SUMMARY (DRY RUN) ============");
console.log(`transactions:        imported ${totalImported}  ruleFailed ${totalFailed}  skipped(non-posting) ${totalSkipped}`);
console.log("by type:");
for (const [t, s] of [...byTypeStats.entries()].sort())
  console.log(`   ${t.padEnd(10)} imported ${String(s.imported).padStart(6)}  failed ${String(s.failed).padStart(5)}  skipped ${String(s.skipped).padStart(5)}`);
console.log(`\ntax engine:          ${taxMatch} match / ${taxMismatch} mismatch  (rate ${taxRate}%,  bothZero ${taxZeroBoth})`);
console.log(`journals→cust_payment classified: ${classifiedCustPayments}`);
console.log(`\ntrial balance:       ${matched}/${allNs.size} accounts reconcile (±$0.01)`);
console.log(`                     ${mismatches.length} mismatched, total abs delta $${fromUnits(totalAbsDelta)}`);
console.log("\nTOP 20 MISMATCHED ACCOUNTS:");
for (const m of mismatches.slice(0, 20))
  console.log(`   ${(m.number + " " + m.name).padEnd(34).slice(0, 34)} ours=${fromUnits(m.ours).padStart(16)} ns=${fromUnits(m.ns_bal).padStart(16)} Δ=${fromUnits(m.delta)}`);
console.log("\nTOP RULE-FAILURE REASONS:");
for (const [r, c] of [...ruleFailReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`   ${String(c).padStart(6)}  ${r}`);
console.log("\nwrote extraction/reconciliation-report.json");

await pool.end();
