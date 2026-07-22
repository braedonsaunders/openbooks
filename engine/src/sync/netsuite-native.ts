import { fromUnits, mulDecimal, normalizeMoney, toUnits } from "../money.ts";
import type { NativeContext, NativeDocLine, NativeDocument } from "./native.ts";

/**
 * NetSuite → native openbooks documents. This is the PROVEN reconstruction
 * logic extracted from the cutover importer (engine/src/import-native.mts,
 * itself validated line-for-line by the reconcile-native dry run against the
 * GL ground truth): classification, sign convention, foreignamount handling,
 * per-line tax computation with the native-tax override decision, transfer
 * pairing, payment control-leg detection, and order (non-posting) building.
 * Parameterized by NativeContext so the LIVE adapter and any replays share
 * one implementation.
 */

// --- Raw SuiteQL shapes (identical to the extraction dumps' fields) -----------

export interface NsHeader {
  id: string;
  ttype: string;
  tranid?: string | null;
  trandate: string; // MM/DD/YYYY
  duedate?: string | null;
  entity?: string | null;
  currency?: string | null;
  memo?: string | null;
  status?: string | null;
  posting?: string | null; // 'T' | 'F'
  otherrefnum?: string | null;
}

export interface NsLine {
  transaction: string;
  id: string;
  mainline: string; // 'T' | 'F'
  taxline: string; // 'T' | 'F'
  account?: string | null;
  expenseaccount?: string | null;
  item?: string | null;
  netamount?: string | null;
  foreignamount?: string | null;
  taxrate1?: string | null;
  taxcode?: string | null;
  department?: string | null;
  entity?: string | null;
  subsidiary?: string | null;
  memo?: string | null;
}

// --- Classification -------------------------------------------------------------

export const NONPOSTING = new Set(["SalesOrd", "PurchOrd", "ItemShip"]);
export const ORDER_KIND: Record<string, string> = {
  SalesOrd: "sales_order",
  PurchOrd: "purchase_order",
};
export const TTYPE_KIND: Record<string, string> = {
  VendBill: "vendor_bill",
  CustInvc: "customer_invoice",
  ExpRept: "expense_report",
  VendPymt: "vendor_payment",
  Check: "check",
  Transfer: "transfer",
  VendCred: "vendor_credit",
  CustCred: "customer_credit",
  CardChrg: "card_charge",
  CardRfnd: "card_refund",
  Journal: "journal",
  // Customer payments and deposits (role now has the permission — imported as
  // REAL payments through the kernel, not photocopied GL):
  CustPymt: "customer_payment",
  Deposit: "deposit",
};
const NEGATE_DETAIL = new Set(["customer_invoice", "vendor_credit"]);
/** Kinds whose per-transaction control account is surfaced onto the document. */
const CONTROL_KINDS = new Set([
  "vendor_bill",
  "vendor_credit",
  "expense_report",
  "customer_invoice",
  "customer_credit",
  "card_charge",
  "card_refund",
  "deposit", // mainline = the bank account deposited into
]);

// --- Helpers (verbatim semantics from the proven importer) -----------------------

const round2 = (u: bigint): bigint => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const q = a / 100n;
  const rem = a % 100n;
  const r = rem >= 50n ? q + 1n : q;
  const cents = r * 100n;
  return neg ? -cents : cents;
};

export const parseNsDate = (mmddyyyy: string): string => {
  const [m, d, y] = mmddyyyy.split("/");
  return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
};

const glUnits = (l: NsLine): bigint =>
  toUnits(
    (l.foreignamount != null && l.foreignamount !== ""
      ? l.foreignamount
      : l.netamount) ?? "0",
  );

function taxOnBase(baseUnits: bigint, rateUnits: bigint): bigint {
  return round2((baseUnits * rateUnits) / (100n * 10000n));
}

// --- The builder -------------------------------------------------------------------

export interface BuiltNative {
  doc: NativeDocument;
  taxComputedMatch: boolean;
}

export function buildNativeFromNetSuite(
  ctx: NativeContext,
  h: NsHeader,
  rawLines: NsLine[],
): BuiltNative | { skip: string } {
  const tt = h.ttype;

  // Non-posting orders → order documents (no GL). ItemShip and unknowns skip.
  if (NONPOSTING.has(tt)) {
    const orderKind = ORDER_KIND[tt];
    if (!orderKind) {
      const hasLineLedgerImpact = rawLines.some(
        (line) =>
          Boolean(line.account ?? line.expenseaccount) && glUnits(line) !== 0n,
      );
      return {
        skip: hasLineLedgerImpact
          ? `unsupported posting type ${tt} has ledger impact`
          : `non-ledger source transaction ${tt}`,
      };
    }
    return buildOrder(ctx, h, rawLines, orderKind);
  }
  if (h.posting !== "T") return { skip: `posting='${h.posting}'` };
  const kind = TTYPE_KIND[tt];
  if (!kind) return { skip: `unmapped type ${tt}` };

  const lineTaxCode = (
    l: NsLine,
  ): { codeId: string; rateUnits: bigint } | null => {
    const tr = l.taxrate1;
    if (tr == null || tr === "") return null;
    const sourceRateUnits = toUnits(mulDecimal(String(tr), "100"));
    if (sourceRateUnits === 0n) return null;
    const sourceCodeId = l.taxcode
      ? ctx.taxCodeByRef.get(String(l.taxcode))
      : null;
    if (sourceCodeId)
      return { codeId: sourceCodeId, rateUnits: sourceRateUnits };
    const key = fromUnits(sourceRateUnits);
    const code =
      ctx.taxByRate.get(key) ?? ctx.taxByRate.get(key.replace(/\.0+$/, ""));
    if (!code) return null;
    const rateUnits = toUnits(code.rate);
    // A percentage does not uniquely identify a NetSuite tax code. Tenants
    // commonly have several 0% codes, so selecting one by rate would invent a
    // business-data change even though there is no tax or GL impact.
    return rateUnits === 0n ? null : { codeId: code.id, rateUnits };
  };

  const partyId = h.entity ? (ctx.partyByRef.get(h.entity) ?? null) : null;
  const sourceSubsidiaryRef =
    rawLines.find((line) => line.mainline === "T" && line.subsidiary)
      ?.subsidiary ??
    rawLines.find((line) => line.subsidiary)?.subsidiary ??
    null;
  const subsidiaryId = sourceSubsidiaryRef
    ? (ctx.subsidiaryByRef.get(sourceSubsidiaryRef) ?? null)
    : null;
  if (sourceSubsidiaryRef && !subsidiaryId) {
    return { skip: `unmapped subsidiary ${sourceSubsidiaryRef}` };
  }
  const unmappedLineSubsidiary = rawLines.find(
    (line) => line.subsidiary && !ctx.subsidiaryByRef.has(line.subsidiary),
  )?.subsidiary;
  if (unmappedLineSubsidiary)
    return { skip: `unmapped subsidiary ${unmappedLineSubsidiary}` };
  const unmappedTaxCode = rawLines.find(
    (line) =>
      line.mainline === "F" &&
      line.taxline === "F" &&
      line.taxcode &&
      toUnits(mulDecimal(String(line.taxrate1 ?? 0), "100")) !== 0n &&
      !ctx.taxCodeByRef.has(String(line.taxcode)),
  )?.taxcode;
  if (unmappedTaxCode) return { skip: `unmapped tax code ${unmappedTaxCode}` };
  const base: Omit<NativeDocument, "kind" | "lines"> = {
    sourceRef: h.id,
    posting: true,
    partyId,
    subsidiaryId,
    documentDate: parseNsDate(h.trandate),
    dueDate: h.duedate ? parseNsDate(h.duedate) : null,
    memo: h.memo ?? null,
    referenceNumber: h.otherrefnum ?? h.tranid ?? null,
    controlAccountId: null,
  };

  // NetSuite's actual tax total (sum of taxline GL amounts).
  let nsTaxUnits = 0n;
  for (const l of rawLines) if (l.taxline === "T") nsTaxUnits += glUnits(l);

  const negate = NEGATE_DETAIL.has(kind);
  const mkAcct = (l: NsLine): string | null => {
    const ref = l.expenseaccount ?? l.account;
    if (!ref) return null;
    return ctx.accountByRef.get(ref)?.id ?? null;
  };
  const dept = (l: NsLine): string | null =>
    l.department ? (ctx.deptByRef.get(l.department) ?? null) : null;
  // A NetSuite transaction line's `entity` (the "Name" column) is polymorphic —
  // it can be a customer/vendor/employee OR a job/project. openbooks ids are
  // disjoint between parties and projects, so resolve it against both: a party
  // ref → line party (subledger entity), a job ref → line project. Previously
  // the entity was force-routed to project only, silently dropping the
  // customer/vendor on AR/AP journal lines (opening-balance / month-end).
  const party = (l: NsLine): string | null =>
    l.entity ? (ctx.partyByRef.get(l.entity) ?? null) : null;
  const proj = (l: NsLine): string | null =>
    l.entity ? (ctx.projectByRef.get(l.entity) ?? null) : null;
  const sub = (l: NsLine): string | null =>
    l.subsidiary
      ? (ctx.subsidiaryByRef.get(l.subsidiary) ?? null)
      : subsidiaryId;

  const lines: NativeDocLine[] = [];
  let lineNo = 0;
  let effKind = kind;
  const push = (
    accountId: string,
    amtUnits: bigint,
    l: NsLine,
    taxCodeId: string | null = null,
  ): NativeDocLine => {
    const row: NativeDocLine = {
      accountId,
      itemId: null,
      amount: fromUnits(amtUnits),
      taxAmount: "0",
      taxOverridden: false,
      taxCodeId,
      partyId: party(l),
      departmentId: dept(l),
      projectId: proj(l),
      description: l.memo ?? null,
      lineNumber: ++lineNo,
      subsidiaryId: sub(l),
    };
    lines.push(row);
    return row;
  };
  const finish = (taxComputedMatch: boolean): BuiltNative => {
    const controlAccountId = CONTROL_KINDS.has(effKind)
      ? controlAccountFor(ctx, rawLines)
      : null;
    // NetSuite can retain a transaction marked posting='T' after every GL line
    // has been reduced to exactly zero (for example a regenerated labour-burden
    // journal). It has no ledger projection in either system. Preserve the
    // source transaction and all of its dimensions as an approved document,
    // but do not ask the posting kernel to manufacture a zero-value journal.
    const hasLedgerImpact = lines.some(
      (line) => toUnits(line.amount) !== 0n || toUnits(line.taxAmount) !== 0n,
    );
    return {
      doc: {
        ...base,
        posting: hasLedgerImpact,
        kind: effKind,
        controlAccountId,
        lines,
      },
      taxComputedMatch,
    };
  };

  if (kind === "journal") {
    for (const l of rawLines) {
      if (l.taxline === "T") continue;
      const acct = mkAcct(l);
      if (!acct)
        return { skip: `unmapped account ${l.expenseaccount ?? l.account}` };
      push(acct, glUnits(l), l);
    }
    if (lines.length === 0) return { skip: "no GL lines" };
    return finish(nsTaxUnits === 0n);
  }

  if (kind === "transfer") {
    const glLines = rawLines
      .filter((l) => l.taxline !== "T")
      .map((l) => ({ l, amt: glUnits(l) }));
    glLines.sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));
    const dest = glLines[0],
      src = glLines[glLines.length - 1];
    if (!dest || !src || dest === src)
      return { skip: "transfer needs two legs" };
    const dAcct = mkAcct(dest.l),
      sAcct = mkAcct(src.l);
    if (!dAcct || !sAcct) return { skip: "unmapped transfer account" };
    const mag = dest.amt < 0n ? -dest.amt : dest.amt;
    push(dAcct, mag, dest.l);
    // Second line at 0: the transfer rule reads lines[0]/[1] account ids;
    // postDocument drops zero AMOUNTS from the projection, not the lines.
    lines.push({
      accountId: sAcct,
      itemId: null,
      amount: "0",
      taxAmount: "0",
      taxOverridden: false,
      taxCodeId: null,
      departmentId: dept(src.l),
      projectId: proj(src.l),
      description: src.l.memo ?? null,
      lineNumber: ++lineNo,
      subsidiaryId: sub(src.l),
    });
    return finish(nsTaxUnits === 0n);
  }

  if (kind === "deposit") {
    // NetSuite Deposit: mainline = bank (+X debit), detail lines = the source
    // accounts (undeposited funds / income) each −Y credit. The deposit RULE
    // wants document lines = the SOURCES with POSITIVE amounts (it re-credits
    // them and debits the bank from the control override).
    for (const l of rawLines) {
      if (l.mainline !== "F" || l.taxline === "T") continue;
      const acct = mkAcct(l);
      if (!acct)
        return { skip: `unmapped account ${l.expenseaccount ?? l.account}` };
      push(acct, -glUnits(l), l);
    }
    if (lines.length === 0) return { skip: "deposit has no source lines" };
    return finish(nsTaxUnits === 0n);
  }

  if (kind === "vendor_payment" || kind === "customer_payment") {
    const controlId =
      kind === "vendor_payment" ? ctx.control.ap : ctx.control.ar;
    const controlRef = ctx.accountRefById.get(controlId);
    const nonTax = rawLines.filter((l) => l.taxline !== "T");
    const ctrlLine = nonTax.find(
      (l) => (l.expenseaccount ?? l.account) === controlRef,
    );
    if (!ctrlLine) {
      // No AP/AR leg → plain money movement → journal pass-through.
      for (const l of nonTax) {
        const acct = mkAcct(l);
        if (!acct)
          return { skip: `unmapped account ${l.expenseaccount ?? l.account}` };
        push(acct, glUnits(l), l);
      }
      if (lines.length < 2)
        return { skip: "payment without control leg or counterlegs" };
      effKind = "journal";
      return finish(nsTaxUnits === 0n);
    }
    const bank =
      nonTax.find((l) => (l.expenseaccount ?? l.account) !== controlRef) ??
      nonTax[0];
    if (!bank) return { skip: "payment without bank leg" };
    const acct = mkAcct(bank);
    if (!acct) return { skip: "unmapped bank account" };
    const totalUnits = glUnits(ctrlLine);
    push(acct, totalUnits < 0n ? -totalUnits : totalUnits, bank);
    return finish(nsTaxUnits === 0n);
  }

  // Standard document: detail lines (mainline='F' AND taxline='F').
  const detailRows: { row: NativeDocLine; codeId: string | null }[] = [];
  const baseByCode = new Map<string, bigint>();
  const rateByCode = new Map<string, bigint>();
  for (const l of rawLines) {
    if (!(l.mainline === "F" && l.taxline === "F")) continue;
    const acct = mkAcct(l);
    if (!acct)
      return { skip: `unmapped account ${l.expenseaccount ?? l.account}` };
    let amtUnits = glUnits(l);
    if (negate) amtUnits = -amtUnits;
    const tc = lineTaxCode(l);
    if (tc) {
      baseByCode.set(tc.codeId, (baseByCode.get(tc.codeId) ?? 0n) + amtUnits);
      rateByCode.set(tc.codeId, tc.rateUnits);
    }
    const row = push(acct, amtUnits, l, tc?.codeId ?? null);
    detailRows.push({ row, codeId: tc?.codeId ?? null });
  }
  if (lines.length === 0) return { skip: "no detail lines" };

  // Our engine's computed tax, rounded ONCE per code.
  const codeTax = new Map<string, bigint>();
  let ourTaxUnits = 0n;
  for (const [codeId, b] of baseByCode)
    codeTax.set(codeId, taxOnBase(b, rateByCode.get(codeId) ?? 0n));
  for (const t of codeTax.values()) ourTaxUnits += t;

  const ourAbs = ourTaxUnits < 0n ? -ourTaxUnits : ourTaxUnits;
  const nsAbs = nsTaxUnits < 0n ? -nsTaxUnits : nsTaxUnits;
  const bothZero = ourAbs === 0n && nsAbs === 0n;
  const within = ourAbs - nsAbs >= -100n && ourAbs - nsAbs <= 100n; // ±$0.01

  if (bothZero || within) {
    const assigned = new Set<string>();
    const carriers: NativeDocLine[] = [];
    for (const { row, codeId } of detailRows) {
      if (!codeId || assigned.has(codeId)) continue;
      const t = codeTax.get(codeId) ?? 0n;
      if (t !== 0n) {
        row.taxAmount = fromUnits(t);
        carriers.push(row);
      }
      assigned.add(codeId);
    }
    // PENNY-EXACT: our once-per-code rounding can differ from NetSuite's
    // per-line rounding by a cent. Nudge the largest carrier by the delta so
    // the posted tax total equals NetSuite's actual to the penny — the split
    // stays engine-computed, the total stays ground truth.
    if (ourAbs !== nsAbs) {
      const delta = nsAbs - ourAbs; // ±1 cent (within tolerance by definition)
      if (carriers.length > 0) {
        const carrier = carriers.reduce((a, b) =>
          (toUnits(b.taxAmount) < 0n
            ? -toUnits(b.taxAmount)
            : toUnits(b.taxAmount)) >
          (toUnits(a.taxAmount) < 0n
            ? -toUnits(a.taxAmount)
            : toUnits(a.taxAmount))
            ? b
            : a,
        );
        const cur = toUnits(carrier.taxAmount);
        carrier.taxAmount = fromUnits(cur + (cur < 0n ? -delta : delta));
      } else {
        // Degenerate: our computed tax is zero everywhere (penny-sized bases
        // round to 0) but NetSuite posted a cent. Carry NS's actual on the
        // first detail line, code fall-back like the override path.
        const first = detailRows[0];
        if (first) {
          first.row.taxAmount = fromUnits(delta);
          first.row.taxOverridden = true;
          if (!first.row.taxCodeId) {
            first.row.taxCodeId =
              ctx.taxByRate.get("13")?.id ?? ctx.taxByRate.get("5")?.id ?? null;
          }
        }
      }
    }
    return finish(true);
  }

  // NetSuite hand-adjusted → carry NS's actual tax (tax_overridden=true) so the
  // GL matches to the cent; the rule re-signs per kind via taxLines().
  const carrier = detailRows.find((d) => d.codeId) ?? detailRows[0];
  if (carrier) {
    carrier.row.taxAmount = fromUnits(nsAbs);
    carrier.row.taxOverridden = true;
    if (!carrier.row.taxCodeId) {
      carrier.row.taxCodeId =
        ctx.taxByRate.get("13")?.id ?? ctx.taxByRate.get("5")?.id ?? null;
    }
  }
  return finish(false);
}

/** Per-transaction control account: the mainline='T' non-tax line's account. */
function controlAccountFor(
  ctx: NativeContext,
  rawLines: NsLine[],
): string | null {
  const ctrl = rawLines.find((l) => l.mainline === "T" && l.taxline === "F");
  if (!ctrl) return null;
  const ref = ctrl.expenseaccount ?? ctrl.account;
  return ref ? (ctx.accountByRef.get(ref)?.id ?? null) : null;
}

/** Non-posting order (sales/purchase): item-based document, totals from lines. */
function buildOrder(
  ctx: NativeContext,
  h: NsHeader,
  rawLines: NsLine[],
  orderKind: string,
): BuiltNative | { skip: string } {
  const detail = rawLines.filter(
    (l) => l.mainline === "F" && l.taxline === "F",
  );
  const lines: NativeDocLine[] = [];
  let n = 0;
  for (const l of detail) {
    const ref = l.expenseaccount ?? l.account;
    const accountId = ref ? (ctx.accountByRef.get(ref)?.id ?? null) : null;
    const itemId = l.item ? (ctx.itemByRef.get(l.item) ?? null) : null;
    if (!accountId && !itemId) continue; // a line needs an account OR an item
    const tr = l.taxrate1;
    const normalizedRate =
      tr != null && tr !== ""
        ? normalizeMoney(mulDecimal(String(tr), "100"))
        : null;
    const code = normalizedRate
      ? (ctx.taxByRate.get(normalizedRate) ??
        ctx.taxByRate.get(normalizedRate.replace(/\.0+$/, "")))
      : null;
    const signedAmount = glUnits(l);
    lines.push({
      accountId,
      itemId,
      // NetSuite sales-order detail is the future credit side of the sale;
      // OpenBooks stores orders in document direction. Opposite-signed source
      // discount lines remain negative after the same normalization.
      amount: fromUnits(
        orderKind === "sales_order" ? -signedAmount : signedAmount,
      ),
      taxAmount: "0",
      taxOverridden: false,
      taxCodeId: code?.id ?? null,
      partyId: l.entity ? (ctx.partyByRef.get(l.entity) ?? null) : null,
      departmentId: l.department
        ? (ctx.deptByRef.get(l.department) ?? null)
        : null,
      projectId: l.entity ? (ctx.projectByRef.get(l.entity) ?? null) : null,
      subsidiaryId: l.subsidiary
        ? (ctx.subsidiaryByRef.get(l.subsidiary) ?? null)
        : null,
      description: l.memo ?? null,
      lineNumber: ++n,
    });
  }
  if (lines.length === 0) return { skip: "order has no resolvable lines" };
  const sub = lines.reduce((s, l) => s + toUnits(l.amount), 0n);
  const subAbs = fromUnits(sub < 0n ? -sub : sub);
  return {
    doc: {
      sourceRef: h.id,
      kind: orderKind,
      posting: false,
      partyId: h.entity ? (ctx.partyByRef.get(h.entity) ?? null) : null,
      subsidiaryId: rawLines.find((line) => line.subsidiary)?.subsidiary
        ? (ctx.subsidiaryByRef.get(
            rawLines.find((line) => line.subsidiary)!.subsidiary!,
          ) ?? null)
        : null,
      documentDate: parseNsDate(h.trandate),
      dueDate: h.duedate ? parseNsDate(h.duedate) : null,
      memo: h.memo ?? null,
      referenceNumber: h.otherrefnum ?? h.tranid ?? null,
      controlAccountId: null,
      subtotal: subAbs,
      total: subAbs,
      lines,
    },
    taxComputedMatch: true,
  };
}
