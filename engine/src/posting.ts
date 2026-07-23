import { and, asc, eq, sql } from "drizzle-orm";
import { db, inDbTransaction, schema } from "./db.ts";
import { add, cmp, isZero, mulRate, neg, sum, toUnits } from "./money.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";
import { emitStatusChange, runRecordFlows } from "./flows/run.ts";
import {
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
} from "./subsidiaries.ts";
import { assertPeriodModulesOpen, closeModuleForDocument, CloseError } from "./close.ts";
import { resolveBillInventoryAccounts } from "./inventory.ts";
import { captureTransactionAuditSnapshot, recordTransactionAudit } from "./transaction-audit.ts";

/**
 * The posting engine: document → journal entry, through the kernel.
 * Rules are pure functions from (document, lines, resolver) to kernel lines;
 * the database triggers are the final authority on balance/immutability.
 * before_post user scripts run first (can mutate whitelisted fields or veto);
 * after_post scripts run once the entry exists.
 */

type Doc = typeof schema.documents.$inferSelect;
type DocLine = typeof schema.documentLines.$inferSelect;

export interface KernelLine {
  accountId: string;
  /** Signed transaction-currency amount; translated before ledger insertion. */
  amount: string;
  currency?: string;
  txnAmount?: string;
  fxRate?: string;
  /** Legal entity; defaults to the document's subsidiary (journals may span). */
  subsidiaryId?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  equipmentUnitId?: string | null;
  /** Custom segment assignments keyed by segment_definitions.key. */
  extraDims?: Record<string, string>;
  paymentCardId?: string | null;
  taxCodeId?: string | null;
  memo?: string | null;
  dueDate?: string | null;
  isOpenItem?: boolean;
}

export interface PostingDeps {
  /** Historical replay: bypass source-imported period locks, never user locks. */
  migration?: boolean;
  /** org-level control accounts (from orgs.settings.controlAccounts). */
  control: {
    ar: string;
    ap: string;
    bank: string;
    taxCollected?: string;
    taxPaid?: string;
    employeePayable?: string;
    fxRealizedGainLoss?: string;
  };
  /** Resolved by postDocument when the document has a payment card. */
  cardLiabilityAccountId?: string;
  /**
   * Accounts whose journal lines are OPEN ITEMS (all asset_receivable /
   * liability_payable accounts). Resolved lazily by postDocument /
   * regenerateGlImpactTx for journal documents; lets a journal's AR/AP legs
   * participate in payment applications — openbooks' model applies ANY
   * crediting document (journal, credit memo, payment) to open items, the way
   * source platform's own receipt journals settle invoices.
   */
  openItemAccountIds?: Set<string>;
  /**
   * Per-tax-code control accounts (tax_codes.collected/paid_account_id).
   * Resolved lazily by postDocument / regenerateGlImpactTx; codes without an
   * account fall back to the org control (taxCollected / taxPaid).
   */
  taxCollectedByCode?: Map<string, string>;
  taxPaidByCode?: Map<string, string>;
  /** Exact per-line tax calculation snapshots, expanded from a code or group. */
  taxComponentsByLine?: Map<string, TaxPostingComponent[]>;
  /**
   * document_line id → deferred-revenue account, for customer_invoice lines
   * whose item carries a recognition rule (ASC 606). Such lines credit deferred
   * revenue instead of income; engine/src/revenue-recognition.ts later drains
   * deferred → earned over the term. Resolved lazily by postDocument /
   * regenerateGlImpactTx for customer_invoice documents.
   */
  deferralAccountByLine?: Map<string, string>;
  /**
   * document_line id → the account a vendor_bill inventory line should DEBIT
   * (received-not-billed clearing, else the inventory asset account). The
   * inventory subledger then receives the stock. Resolved lazily by
   * postDocument / regenerateGlImpactTx for vendor_bill documents.
   */
  inventoryAssetByLine?: Map<string, string>;
}

export interface TaxPostingComponent {
  taxCodeId: string;
  sequence: number;
  taxAmount: string;
  recoverableAmount: string;
  nonrecoverableAmount: string;
  calculationType: "standard" | "withholding" | "reverse_charge";
  collectedAccountId: string | null;
  paidAccountId: string | null;
  withholdingAccountId: string | null;
}

/**
 * An AR/AP journal line participates in the subledger only when it identifies
 * the customer/vendor whose balance it changes. source platform permits direct GL
 * journals to control accounts without an entity; those remain legitimate
 * control-account GL activity, but must not become anonymous aging items.
 */
export function controlLineIsOpenItem(
  accountId: string,
  partyId: string | null | undefined,
  openItemAccountIds?: ReadonlySet<string>,
): boolean {
  return partyId != null && openItemAccountIds?.has(accountId) === true;
}

/** document_line id → deferred-revenue account for rev-rec invoice lines. */
async function resolveDeferralAccounts(
  runner: Pick<typeof db, "execute">,
  documentId: string,
): Promise<Map<string, string>> {
  const r = (await runner.execute(sql`
    select dl.id as line_id,
           coalesce(it.deferred_account_id, r.deferred_account_id) as deferred_account_id
      from document_lines dl
      join items it on it.id = dl.item_id and it.recognition_rule_id is not null
      join recognition_rules r on r.id = it.recognition_rule_id
     where dl.document_id = ${documentId}
       and coalesce(it.deferred_account_id, r.deferred_account_id) is not null`)) as unknown as {
    rows: { line_id: string; deferred_account_id: string }[];
  };
  const map = new Map<string, string>();
  for (const row of r.rows) map.set(row.line_id, row.deferred_account_id);
  return map;
}

/** tax code id → its own collected/paid control accounts, when configured. */
async function resolveTaxAccounts(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<{ collected: Map<string, string>; paid: Map<string, string> }> {
  const r = (await runner.execute(sql`
    select id, collected_account_id, paid_account_id from tax_codes
     where org_id = ${orgId} and (collected_account_id is not null or paid_account_id is not null)`)) as unknown as {
    rows: { id: string; collected_account_id: string | null; paid_account_id: string | null }[];
  };
  const collected = new Map<string, string>();
  const paid = new Map<string, string>();
  for (const row of r.rows) {
    if (row.collected_account_id) collected.set(row.id, row.collected_account_id);
    if (row.paid_account_id) paid.set(row.id, row.paid_account_id);
  }
  return { collected, paid };
}

async function resolveTaxComponents(
  runner: Pick<typeof db, "execute">,
  documentId: string,
): Promise<Map<string, TaxPostingComponent[]>> {
  const result = (await runner.execute(sql`
    select c.document_line_id, c.tax_code_id, c.sequence, c.tax_amount::text,
           c.recoverable_amount::text, c.nonrecoverable_amount::text,
           c.calculation_type, c.collected_account_id, c.paid_account_id,
           c.withholding_account_id
      from document_line_tax_components c
      join document_lines dl on dl.id = c.document_line_id
     where dl.document_id = ${documentId}
     order by c.document_line_id, c.sequence
  `)) as unknown as { rows: Record<string, any>[] };
  const byLine = new Map<string, TaxPostingComponent[]>();
  for (const row of result.rows) {
    const lineId = String(row.document_line_id);
    const components = byLine.get(lineId) ?? [];
    components.push({
      taxCodeId: String(row.tax_code_id),
      sequence: Number(row.sequence),
      taxAmount: String(row.tax_amount),
      recoverableAmount: String(row.recoverable_amount),
      nonrecoverableAmount: String(row.nonrecoverable_amount),
      calculationType: row.calculation_type,
      collectedAccountId: row.collected_account_id,
      paidAccountId: row.paid_account_id,
      withholdingAccountId: row.withholding_account_id,
    });
    byLine.set(lineId, components);
  }
  return byLine;
}

type RuleFn = (doc: Doc, lines: DocLine[], deps: PostingDeps) => KernelLine[];

/**
 * Card charge / refund. A charge DRs its expense lines and CRs the card's
 * liability control account; a refund is the arithmetic reverse and rides the
 * same rule with negative line amounts (its detail is stored already signed).
 * The liability account is the doc's `controlAccountId` override (the per-card
 * employee sub-account source platform used) else the resolved card liability.
 */
const cardRule: RuleFn = (doc, lines, deps) => {
  const expense: KernelLine[] = lines.map((l) => ({
    accountId: l.accountId!,
    amount: purchaseBaseAmount(l, deps),
    memo: l.description,
    partyId: l.partyId ?? doc.partyId,
    paymentCardId: doc.paymentCardId,
    ...dims(doc, l),
  }));
  const tax = purchaseTaxLines(doc, lines, deps, 1);
  const total = sum([...expense, ...tax].map((l) => l.amount));
  const cardLiability = controlOverride(doc) ?? deps.cardLiabilityAccountId;
  if (!cardLiability) throw new PostingError("card_charge requires a payment card");
  return [
    ...expense,
    ...tax,
    {
      accountId: cardLiability,
      amount: neg(total),
      paymentCardId: doc.paymentCardId,
      ...dims(doc),
    },
  ];
};

const dims = (d: Doc, l?: DocLine) => ({
  departmentId: l?.departmentId ?? d.departmentId,
  projectId: l?.projectId ?? d.projectId,
  locationId: l?.locationId ?? d.locationId,
  classId: l?.classId ?? d.classId,
  equipmentUnitId: l?.equipmentUnitId ?? null,
  extraDims: {
    ...((d.extraDims ?? {}) as Record<string, string>),
    ...((l?.extraDims ?? {}) as Record<string, string>),
  },
});

/** Pure GL projection for a financial equipment/resource charge. The debit is
 * job cost; the credit relieves a distinct recovery pool. Keeping this helper
 * exported makes the accounting invariant directly testable. */
export function projectChargeKernelLines(doc: Doc, lines: DocLine[]): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    if (!line.accountId) throw new PostingError("project charge requires a cost account");
    if (!line.recoveryAccountId) throw new PostingError("project charge requires a cost recovery account");
    if (line.recoveryAccountId === line.accountId) {
      throw new PostingError("project charge cost and recovery accounts must be different");
    }
    out.push({ accountId: line.accountId, amount: line.amount, memo: line.description, ...dims(doc, line) });
    out.push({
      accountId: line.recoveryAccountId,
      amount: neg(line.amount),
      memo: line.description,
      departmentId: doc.departmentId,
      locationId: doc.locationId,
      classId: doc.classId,
      projectId: null,
      equipmentUnitId: line.equipmentUnitId,
      extraDims: (doc.extraDims ?? {}) as Record<string, string>,
    });
  }
  return out;
}

async function validateRequiredDimensions(
  runner: Pick<typeof db, "execute">,
  orgId: string,
  lines: KernelLine[],
): Promise<void> {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const rows = (await runner.execute(sql`
    select a.id, a.number, a.name, a.required_dimensions,
           coalesce(jsonb_object_agg(sd.key, sd.name) filter (where sd.key is not null), '{}'::jsonb) as segment_names
      from accounts a
      left join segment_definitions sd on sd.org_id = a.org_id and sd.is_active
     where a.org_id = ${orgId}
       and a.id = any(${`{${accountIds.join(",")}}`}::uuid[])
     group by a.id
  `)) as unknown as {
    rows: { id: string; number: string | null; name: string; required_dimensions: string[]; segment_names: Record<string, string> }[];
  };
  const byAccount = new Map(rows.rows.map((row) => [row.id, row]));
  const builtin: Record<string, keyof KernelLine> = {
    subsidiary: "subsidiaryId",
    department: "departmentId",
    project: "projectId",
    location: "locationId",
    class: "classId",
    party: "partyId",
  };
  for (const line of lines) {
    const account = byAccount.get(line.accountId);
    for (const key of account?.required_dimensions ?? []) {
      const present = builtin[key]
        ? Boolean(line[builtin[key]!])
        : Boolean(line.extraDims?.[key]);
      if (!present) {
        const label = account?.segment_names?.[key] ?? (key === "party" ? "Party" : key);
        throw new PostingError(
          `${label} is required for account ${account?.number ? `${account.number} · ` : ""}${account?.name ?? line.accountId}`,
        );
      }
    }
  }
}

const lineTotal = (l: DocLine) => add(l.amount, l.taxAmount ?? "0");

/**
 * The payable/receivable/card-liability control account a document should post
 * to. source platform lets a transaction choose its own AP/AR/financing account on the
 * header (usually the org default, but sometimes a financing sub-account like
 * "Ford Credit" or a per-card employee liability). We surface that choice as
 * `doc.custom.controlAccountId`; when present it wins over the org default.
 */
const controlOverride = (doc: Doc): string | undefined => {
  const c = (doc.custom as Record<string, unknown> | null)?.controlAccountId;
  return typeof c === "string" && c ? c : undefined;
};

function componentSettlementTotal(components: TaxPostingComponent[]): string {
  const standard = sum(components.filter((c) => c.calculationType === "standard").map((c) => c.taxAmount));
  const withholding = sum(components.filter((c) => c.calculationType === "withholding").map((c) => c.taxAmount));
  return add(standard, neg(withholding));
}

function componentsForLine(line: DocLine, deps: PostingDeps): TaxPostingComponent[] {
  const components = deps.taxComponentsByLine?.get(line.id) ?? [];
  const hasTaxProfile = Boolean(line.taxCodeId || line.taxGroupId);
  if (hasTaxProfile && components.length === 0) {
    throw new PostingError(`line ${line.lineNumber} has a tax profile but no calculation evidence`);
  }
  if (components.length > 0) {
    const settlement = componentSettlementTotal(components);
    if (cmp(settlement, line.taxAmount ?? "0") !== 0) {
      throw new PostingError(
        `line ${line.lineNumber} tax components (${settlement}) do not match stored tax total (${line.taxAmount})`,
      );
    }
  }
  return components;
}

function signed(amount: string, direction: 1 | -1): string {
  return direction === 1 ? amount : neg(amount);
}

/** Expense/inventory basis includes only the nonrecoverable purchase tax. */
function purchaseBaseAmount(line: DocLine, deps: PostingDeps): string {
  const nonrecoverable = sum(
    componentsForLine(line, deps)
      .filter((c) => c.calculationType !== "withholding")
      .map((c) => c.nonrecoverableAmount),
  );
  return add(line.amount, nonrecoverable);
}

/**
 * Purchase tax projection:
 * - standard: recoverable input tax only (nonrecoverable was capitalized above)
 * - withholding: credit the statutory withholding payable
 * - reverse charge: debit recoverable input, credit full output liability;
 *   nonrecoverable input remains in expense/inventory.
 */
function purchaseTaxLines(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
  direction: 1 | -1,
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    for (const component of componentsForLine(line, deps)) {
      const common = { taxCodeId: component.taxCodeId, partyId: line.partyId ?? doc.partyId, ...dims(doc, line) };
      if (component.calculationType === "withholding") {
        if (!component.withholdingAccountId) {
          throw new PostingError(`withholding tax ${component.taxCodeId} has no withholding account`);
        }
        out.push({ ...common, accountId: component.withholdingAccountId, amount: signed(neg(component.taxAmount), direction) });
        continue;
      }
      if (!isZero(component.recoverableAmount)) {
        out.push({
          ...common,
          accountId: component.paidAccountId ?? deps.taxPaidByCode?.get(component.taxCodeId) ?? deps.control.taxPaid ?? deps.control.ap,
          amount: signed(component.recoverableAmount, direction),
        });
      }
      if (component.calculationType === "reverse_charge" && !isZero(component.taxAmount)) {
        out.push({
          ...common,
          accountId: component.collectedAccountId ?? deps.taxCollectedByCode?.get(component.taxCodeId) ?? deps.control.taxCollected ?? deps.control.ap,
          amount: signed(neg(component.taxAmount), direction),
        });
      }
    }
  }
  return out;
}

/** Sales tax projection: standard output liability, withholding receivable. */
function salesTaxLines(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
  direction: 1 | -1,
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    for (const component of componentsForLine(line, deps)) {
      const common = { taxCodeId: component.taxCodeId, partyId: line.partyId ?? doc.partyId, ...dims(doc, line) };
      if (component.calculationType === "reverse_charge") continue;
      if (component.calculationType === "withholding") {
        if (!component.withholdingAccountId) {
          throw new PostingError(`withholding tax ${component.taxCodeId} has no withholding account`);
        }
        out.push({ ...common, accountId: component.withholdingAccountId, amount: signed(component.taxAmount, direction) });
      } else {
        out.push({
          ...common,
          accountId: component.collectedAccountId ?? deps.taxCollectedByCode?.get(component.taxCodeId) ?? deps.control.taxCollected ?? deps.control.ar,
          amount: signed(neg(component.taxAmount), direction),
        });
      }
    }
  }
  return out;
}

export const RULES: Record<string, RuleFn> = {
  vendor_bill: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      // Inventory item lines DR the clearing/asset account (subledger receives
      // the stock); all other lines DR their expense account.
      accountId: deps.inventoryAssetByLine?.get(l.id) ?? l.accountId!,
      amount: purchaseBaseAmount(l, deps), // debit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: neg(total), // credit AP
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  customer_invoice: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      // Rev-rec lines credit deferred revenue; recognition drains it over the
      // term. All other lines credit income directly.
      accountId: deps.deferralAccountByLine?.get(l.id) ?? l.accountId!,
      amount: neg(l.amount), // credit income / deferred revenue
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = salesTaxLines(doc, lines, deps, 1);
    const total = sum([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(total), // debit AR (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...income,
      ...tax,
    ];
  },

  vendor_payment: (doc, lines, deps) => {
    const cash = sum(lines.map(lineTotal));
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    const discount = typeof custom.discountAmount === "string" ? custom.discountAmount : "0";
    const discountAccountId = typeof custom.discountAccountId === "string" ? custom.discountAccountId : null;
    if (toUnits(discount) < 0n) throw new Error("vendor payment discount cannot be negative");
    if (!isZero(discount) && !discountAccountId) throw new Error("vendor payment discount account is required");
    const payable = add(cash, discount);
    return [
      // The AP leg is an OPEN ITEM: it settles against the bills it paid, so it
      // must carry is_open_item to be a valid application source (from_line).
      // controlOverride: a payment against a non-default payable account (a
      // financing sub-account, or a source system with several AP accounts).
      { accountId: controlOverride(doc) ?? deps.control.ap, amount: payable, partyId: doc.partyId, isOpenItem: true, ...dims(doc) }, // debit AP
      { accountId: lines[0]?.accountId ?? deps.control.bank, amount: neg(cash), ...dims(doc) }, // credit bank
      ...(!isZero(discount)
        ? [{ accountId: discountAccountId!, amount: neg(discount), partyId: doc.partyId, ...dims(doc) }]
        : []),
    ];
  },

  customer_payment: (doc, lines, deps) => {
    const total = sum(lines.map(lineTotal));
    return [
      { accountId: lines[0]?.accountId ?? deps.control.bank, amount: total, ...dims(doc) }, // debit bank
      // The AR leg is an OPEN ITEM: it settles the invoices it paid (from_line).
      { accountId: controlOverride(doc) ?? deps.control.ar, amount: neg(total), partyId: doc.partyId, isOpenItem: true, ...dims(doc) }, // credit AR
    ];
  },

  expense_report: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: purchaseBaseAmount(l, deps),
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: controlOverride(doc) ?? deps.control.employeePayable ?? deps.control.ap,
        amount: neg(total),
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      },
    ];
  },

  card_charge: cardRule,
  /** Card refund: the arithmetic reverse of a charge, same posting rule. */
  card_refund: cardRule,

  /** Manual journal: lines carry signed amounts + accounts directly. A line
   *  may name its own subsidiary (intercompany journal); the engine injects
   *  the due-to/due-from legs that keep every subsidiary balanced. */
  journal: (doc, lines, deps) =>
    lines.map((l) => {
      // Line-level entity: a journal line names its own customer/vendor (source
      // systems put the entity on the LINE, e.g. opening-balance journals).
      // Falls back to the header party when the line has none.
      const partyId = l.partyId ?? doc.partyId;
      return {
        accountId: l.accountId!,
        amount: l.amount,
        subsidiaryId: l.subsidiaryId,
        memo: l.description,
        partyId,
        // Entity-bearing AR/AP journal legs are open items. A party-less leg is
        // a direct GL control-account posting and intentionally stays outside
        // aging; manufacturing an anonymous subledger balance would be false.
        isOpenItem: controlLineIsOpenItem(l.accountId!, partyId, deps.openItemAccountIds),
        ...dims(doc, l),
      };
    }),

  /**
   * Check: a direct bank disbursement. DR the line accounts (expense or the
   * AP/liability being paid), CR bank. Like vendor_payment but the debit side
   * is the document's own line accounts. Purchase-side tax (taxPaid).
   */
  check: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: purchaseBaseAmount(l, deps), // debit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, 1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      ...expense,
      ...tax,
      {
        accountId: deps.control.bank,
        amount: neg(total), // credit bank
        ...dims(doc),
      },
    ];
  },

  /**
   * Deposit (Make Deposits): DR the destination bank (the doc's control-account
   * override, else the org default bank) for the sum of the source lines, CR
   * each source account. The mirror of `check`.
   */
  deposit: (doc, lines, deps) => {
    const sources: KernelLine[] = lines.map((l) => {
      const partyId = l.partyId ?? doc.partyId;
      return {
        accountId: l.accountId!,
        amount: neg(l.amount), // credit each source
        memo: l.description,
        partyId,
        // A deposit can settle an AR/AP credit (for example cash received for
        // a vendor credit). Preserve that entity-bearing control leg as an
        // application source; ordinary income/clearing sources stay non-open.
        isOpenItem: controlLineIsOpenItem(l.accountId!, partyId, deps.openItemAccountIds),
        ...dims(doc, l),
      };
    });
    const total = sum(lines.map((l) => l.amount)); // positive = money in
    return [
      { accountId: controlOverride(doc) ?? deps.control.bank, amount: total, ...dims(doc) }, // debit bank
      ...sources,
    ];
  },

  /** Transfer: DR one account, CR another, equal amounts (line 0 = to, line 1 = from). */
  transfer: (doc, lines, deps) => {
    const total = sum(lines.map((l) => l.amount));
    return [
      { accountId: lines[0]?.accountId ?? deps.control.bank, amount: total, ...dims(doc) }, // debit destination
      { accountId: lines[1]?.accountId ?? deps.control.bank, amount: neg(total), ...dims(doc) }, // credit source
    ];
  },

  /** Vendor credit memo: the reverse of vendor_bill. DR AP / CR expense + tax. */
  vendor_credit: (doc, lines, deps) => {
    const expense: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: neg(purchaseBaseAmount(l, deps)), // credit net + nonrecoverable tax
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = purchaseTaxLines(doc, lines, deps, -1);
    const total = sum([...expense, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: neg(total), // debit AP (total is negative)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...expense,
      ...tax,
    ];
  },

  /** Customer credit memo: the reverse of customer_invoice. DR income / CR AR + tax. */
  customer_credit: (doc, lines, deps) => {
    const income: KernelLine[] = lines.map((l) => ({
      accountId: l.accountId!,
      amount: l.amount, // debit income (reverse of invoice)
      memo: l.description,
      partyId: l.partyId ?? doc.partyId,
      ...dims(doc, l),
    }));
    const tax = salesTaxLines(doc, lines, deps, -1);
    const total = sum([...income, ...tax].map((l) => l.amount));
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(total), // credit AR (total is positive)
        partyId: doc.partyId,
        dueDate: doc.dueDate,
        isOpenItem: true,
        ...dims(doc),
      },
      ...income,
      ...tax,
    ];
  },

  /**
   * Project charge / resource usage — allocate a pooled, already-incurred cost
   * onto a project at a cost rate. Per line: DEBIT the target project-COGS
   * account carrying the PROJECT dimension (the job now bears the cost), and
   * CREDIT the source cost pool with NO project (relieve the untagged pool that
   * the original bulk vendor bill posted into). When the item has no dedicated
   * recovery account the credit is the same account as the debit — a pure
   * dimensional reclass (net-zero to the account total, re-attributed to the
   * project), so there is no double-count. A dedicated recovery account instead
   * gives absorption tracking (e.g. owned-equipment recovery vs depreciation).
   * The line's billable rate/markup rides on is_billable for T&M billing; it is
   * NOT posted here (revenue posts at invoice time).
   */
  project_charge: projectChargeKernelLines,
};

export class PostingError extends Error {}

/**
 * Application-layer proof immediately before a ledger write. PostgreSQL
 * repeats these assertions at the deferred-constraint boundary; keeping both
 * defenses independent turns a malformed projection into a readable posting
 * error before any journal row is inserted.
 */
export function assertFinalKernelBalance(
  lines: readonly { amount: string; subsidiaryId: string }[],
): void {
  if (lines.length < 2) throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(lines.map((line) => line.amount));
  if (!isZero(total)) throw new PostingError(`functional-currency journal does not balance (sum=${total})`);
  const bySubsidiary = new Map<string, string[]>();
  for (const line of lines) {
    const amounts = bySubsidiary.get(line.subsidiaryId) ?? [];
    amounts.push(line.amount);
    bySubsidiary.set(line.subsidiaryId, amounts);
  }
  for (const [subsidiaryId, amounts] of bySubsidiary) {
    const subsidiaryTotal = sum(amounts);
    if (!isZero(subsidiaryTotal)) {
      throw new PostingError(
        `functional-currency journal does not balance for subsidiary ${subsidiaryId} (sum=${subsidiaryTotal})`,
      );
    }
  }
}

/**
 * Accounts whose lines are open items on a journal (all AR/AP-typed accounts
 * of the org). One indexed select; called only for journal documents.
 */
async function resolveOpenItemAccounts(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<Set<string>> {
  const r = (await runner.execute(sql`
    select id from accounts
     where org_id = ${orgId} and type in ('asset_receivable', 'liability_payable')`)) as unknown as {
    rows: { id: string }[];
  };
  return new Set(r.rows.map((x) => x.id));
}

/**
 * Resolve every kernel line to a legal entity and make the entry balance per
 * subsidiary: stamp doc-default subsidiaries, inject intercompany due-to/
 * due-from legs when lines span entities, and validate account / dimension /
 * party subsidiary restrictions. Shared by first posting and regeneration.
 */
async function applySubsidiaries(
  runner: Pick<typeof db, "execute">,
  doc: Doc,
  kernelLines: KernelLine[],
): Promise<{
  lines: (KernelLine & { subsidiaryId: string; currency: string; txnAmount: string; fxRate: string })[];
  docSubId: string;
  multi: boolean;
}> {
  try {
    const ctx = await loadSubsidiaryContext(runner, doc.orgId);
    const docSubId = doc.subsidiaryId ?? ctx.rootId;
    const origin = ctx.byId.get(docSubId);
    if (!origin) throw new SubsidiaryError(`subsidiary ${docSubId} does not exist`);
    const postingDate = doc.postingDate ?? doc.documentDate;
    const rateCache = new Map<string, string>();

    const functionalRate = async (targetCurrency: string): Promise<string> => {
      if (doc.currency === targetCurrency) return "1";
      if (targetCurrency === origin.baseCurrency) return doc.fxRate;
      const cached = rateCache.get(targetCurrency);
      if (cached) return cached;
      const r = (await runner.execute(sql`
        select rate::text from (
          select rate, as_of from fx_rates
           where org_id = ${doc.orgId} and from_currency = ${doc.currency}
             and to_currency = ${targetCurrency} and rate_type = 'spot'
             and as_of <= ${postingDate}
          union all
          select (1 / rate)::numeric(19,10) as rate, as_of from fx_rates
           where org_id = ${doc.orgId} and from_currency = ${targetCurrency}
             and to_currency = ${doc.currency} and rate_type = 'spot'
             and as_of <= ${postingDate}
        ) candidates order by as_of desc limit 1`)) as unknown as { rows: { rate: string }[] };
      const rate = r.rows[0]?.rate;
      if (!rate) {
        throw new SubsidiaryError(
          `no spot rate for ${doc.currency}→${targetCurrency} on or before ${postingDate}`,
        );
      }
      rateCache.set(targetCurrency, rate);
      return rate;
    };

    const stamped = await Promise.all(kernelLines.map(async (line) => {
      const subsidiaryId = line.subsidiaryId ?? docSubId;
      const subsidiary = ctx.byId.get(subsidiaryId);
      if (!subsidiary) throw new SubsidiaryError(`subsidiary ${subsidiaryId} does not exist`);
      const fxRate = await functionalRate(subsidiary.baseCurrency);
      return {
        ...line,
        subsidiaryId,
        amount: mulRate(line.amount, fxRate),
        currency: doc.currency,
        txnAmount: line.amount,
        fxRate,
      };
    }));
    const legs = await intercompanyBalancingLegs(runner, {
      orgId: doc.orgId,
      ctx,
      originSubId: docSubId,
      originFxRate: await functionalRate(origin.baseCurrency),
      lines: stamped,
    });
    const all = [
      ...stamped,
      ...legs.map((leg) => ({
        accountId: leg.accountId,
        amount: leg.amount,
        currency: leg.currency,
        txnAmount: leg.txnAmount,
        fxRate: leg.fxRate,
        subsidiaryId: leg.subsidiaryId,
        memo: leg.memo,
      })),
    ];
    await validateSubsidiaryRestrictions(runner, {
      orgId: doc.orgId,
      ctx,
      lines: all,
      partyId: doc.partyId,
      docSubsidiaryId: docSubId,
    });
    return { lines: all, docSubId, multi: new Set(all.map((l) => l.subsidiaryId)).size > 1 };
  } catch (err) {
    if (err instanceof SubsidiaryError) throw new PostingError(err.message);
    throw err;
  }
}

export async function postDocument(
  documentId: string,
  deps: PostingDeps,
  options: {
    deferEffects?: boolean;
    audit?: { actorId: string | null; source: string };
  } = {},
): Promise<string> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  if (doc.status === "posted") throw new PostingError(`document ${doc.documentNumber} already posted`);
  if (doc.status === "voided") throw new PostingError(`document ${doc.documentNumber} is voided`);
  if ((doc.kind === "journal" || doc.kind === "deposit") && !deps.openItemAccountIds) {
    deps = { ...deps, openItemAccountIds: await resolveOpenItemAccounts(db, doc.orgId) };
  }
  if (!deps.taxCollectedByCode && doc.kind !== "journal") {
    const tax = await resolveTaxAccounts(db, doc.orgId);
    deps = { ...deps, taxCollectedByCode: tax.collected, taxPaidByCode: tax.paid };
  }
  if (!deps.taxComponentsByLine && doc.kind !== "journal") {
    deps = { ...deps, taxComponentsByLine: await resolveTaxComponents(db, doc.id) };
  }
  if (doc.kind === "customer_invoice" && !deps.deferralAccountByLine) {
    deps = { ...deps, deferralAccountByLine: await resolveDeferralAccounts(db, doc.id) };
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = { ...deps, inventoryAssetByLine: await resolveBillInventoryAccounts(db, doc.orgId, doc.id) };
  }

  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(eq(schema.documentLines.documentId, documentId))
    .orderBy(asc(schema.documentLines.lineNumber));

  const rule = RULES[doc.kind];
  if (!rule) throw new PostingError(`no posting rule for document kind "${doc.kind}"`);

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await db
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, doc.paymentCardId));
    if (card) deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }

  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, doc.orgId));
  const scriptCtx: ScriptContext = {
    trigger: "before_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
  };

  // -- user scripts: before_post (veto / mutate) --------------------------
  const outcomes = await runTriggerScripts("before_post", scriptCtx, doc.id);
  const bad = outcomes.find((o) => o.status !== "ok");
  if (bad) {
    throw new PostingError(
      bad.status === "aborted"
        ? `posting vetoed by script "${bad.name}": ${bad.abortReason}`
        : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
    );
  }
  let effectiveDoc = doc;
  const mutations = Object.assign({}, ...outcomes.map((o) => o.set ?? {}));
  if (Object.keys(mutations).length > 0) {
    const [updated] = await db
      .update(schema.documents)
      .set(mutations)
      .where(eq(schema.documents.id, doc.id))
      .returning();
    effectiveDoc = updated;
  }

  // -- flows: before_post (automation only, never a veto) ------------------
  // A before_post flow may set_field whitelisted headers; re-read the
  // document so its projection reflects them.
  const beforePostFlows = await runRecordFlows({ kind: "before_post" }, doc.kind, doc.id, {
    orgId: doc.orgId,
  });
  if (beforePostFlows.runs.length > 0) {
    const [refreshed] = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, doc.id));
    if (refreshed) effectiveDoc = refreshed;
  }

  // -- build + validate kernel lines --------------------------------------
  const kernelLines = rule(effectiveDoc, lines, deps).filter((l) => !isZero(l.amount));
  if (kernelLines.length < 2) throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(kernelLines.map((l) => l.amount));
  if (!isZero(total)) {
    throw new PostingError(`posting rule for ${doc.kind} does not balance (sum=${total})`);
  }

  // -- open-item lines must carry a subledger party (AR/AP faithfulness) ----
  // Every source system (source platform line "Name", source platform line Entity) puts a
  // customer/vendor on each AR/AP line, and both enforce AR⇒customer, AP⇒vendor.
  // An open-item leg with no party can't age or net by entity — the exact defect
  // that let party-less month-end journals corrupt the subledger↔GL tie-out.
  // Fail loudly rather than post a party-less receivable/payable.
  const orphanOpenItem = kernelLines.find((l) => l.isOpenItem && !l.partyId);
  if (orphanOpenItem) {
    throw new PostingError(
      `open-item line on account ${orphanOpenItem.accountId} has no party — every AR/AP line must carry its customer/vendor (line entity)`,
    );
  }

  // -- subsidiaries: stamp, intercompany-balance, validate restrictions ----
  const subApplied = await applySubsidiaries(db, effectiveDoc, kernelLines);
  assertFinalKernelBalance(subApplied.lines);
  await validateRequiredDimensions(db, doc.orgId, subApplied.lines);

  const postingDate = effectiveDoc.postingDate ?? effectiveDoc.documentDate;
  const periodRes = (await db.execute(sql`
    select id from accounting_periods
    where org_id = ${doc.orgId} and starts_on <= ${postingDate} and ends_on >= ${postingDate}
      and is_adjustment = false
    limit 1`)) as unknown as { rows: { id: string }[] };
  const period = periodRes.rows[0];
  if (!period) throw new PostingError(`no accounting period covers ${postingDate}`);

  const [book] = await db
    .select()
    .from(schema.accountingBooks)
    .where(sql`${schema.accountingBooks.orgId} = ${doc.orgId} and ${schema.accountingBooks.isPrimary} = true`);
  if (!book) throw new PostingError("primary accounting book is not configured");
  try {
    await assertPeriodModulesOpen(db, {
      orgId: doc.orgId,
      periodId: period.id,
      bookId: book.id,
      subsidiaryIds: subApplied.lines.map((line) => line.subsidiaryId),
      modules: [closeModuleForDocument(doc.kind)],
      allowImportedLocks: deps.migration,
    });
  } catch (error) {
    if (error instanceof CloseError) throw new PostingError(error.message);
    throw error;
  }

  // -- write entry + lines + flip document, atomically ---------------------
  const entryId = await inDbTransaction(async (tx) => {
    if (deps.migration) await tx.execute(sql`set local openbooks.migration = on`);
    const auditBefore = options.audit
      ? await captureTransactionAuditSnapshot(tx, documentId)
      : null;
    if (options.audit && !auditBefore) {
      throw new PostingError(`document ${documentId} disappeared before posting`);
    }
    const [entry] = await tx
      .insert(schema.journalEntries)
      .values({
        orgId: doc.orgId,
        bookId: book.id,
        subsidiaryId: subApplied.docSubId,
        entryNumber: `${effectiveDoc.documentNumber}`,
        postingDate,
        periodId: period.id,
        memo: effectiveDoc.memo,
        status: "draft",
        sourceDocumentId: doc.id,
        origin: subApplied.multi ? "intercompany" : "document",
      })
      .returning({ id: schema.journalEntries.id });

    await tx.insert(schema.journalLines).values(
      subApplied.lines.map((l, i) => ({
        orgId: doc.orgId,
        entryId: entry.id,
        lineNumber: i + 1,
        accountId: l.accountId,
        subsidiaryId: l.subsidiaryId,
        amount: l.amount,
        currency: l.currency,
        txnAmount: l.txnAmount,
        fxRate: l.fxRate,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        equipmentUnitId: l.equipmentUnitId ?? null,
        extraDims: l.extraDims ?? {},
        paymentCardId: l.paymentCardId ?? null,
        taxCodeId: l.taxCodeId ?? null,
        memo: l.memo ?? null,
        dueDate: l.dueDate ?? null,
        isOpenItem: l.isOpenItem ?? false,
      })),
    );

    await tx
      .update(schema.journalEntries)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(schema.journalEntries.id, entry.id));

    // Exactly-once posting, serialized at the aggregate root: the flip only
    // lands while the document is still unposted. Postgres row-locks the
    // document during this UPDATE, so a concurrent post blocks here, then
    // re-evaluates the predicate against the now-'posted' row and matches 0
    // rows. Zero rows → throw → THIS transaction rolls back, discarding the
    // entry + lines just inserted. A document can never produce two entries.
    const flipped = await tx
      .update(schema.documents)
      .set({ status: "posted", postedEntryId: entry.id, postingDate })
      .where(
        and(
          eq(schema.documents.id, doc.id),
          sql`${schema.documents.status} not in ('posted', 'voided')`,
        ),
      )
      .returning({ id: schema.documents.id });
    if (flipped.length === 0) {
      throw new PostingError(`document ${doc.documentNumber} was already posted or voided`);
    }

    if (options.audit && auditBefore) {
      const auditAfter = await captureTransactionAuditSnapshot(tx, documentId);
      if (!auditAfter) throw new PostingError(`document ${documentId} disappeared during posting`);
      await recordTransactionAudit(tx, {
        orgId: doc.orgId,
        documentId,
        action: "post",
        actorId: options.audit.actorId,
        source: options.audit.source,
        before: auditBefore,
        after: auditAfter,
      });
    }

    return entry.id;
  });

  if (!options.deferEffects) {
    await runTriggerScripts("after_post", { ...scriptCtx, trigger: "after_post" }, doc.id);
    // -- flows: after_post + the status transition (never throws) -----------
    await runRecordFlows({ kind: "after_post" }, doc.kind, doc.id, { orgId: doc.orgId });
    await emitStatusChange(doc.kind, doc.id, { from: doc.status, to: "posted" }, { orgId: doc.orgId });
  }
  return entryId;
}

/**
 * Emit post-commit effects for a caller that used `deferEffects` so a larger
 * accounting unit (for example payment + applications + realized FX) could
 * commit atomically before any automation observes it.
 */
export async function runPostDocumentEffects(
  documentId: string,
  previousStatus = "draft",
): Promise<void> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  if (!doc || doc.status !== "posted") return;
  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(eq(schema.documentLines.documentId, documentId))
    .orderBy(asc(schema.documentLines.lineNumber));
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, doc.orgId));
  if (!org) return;
  const ctx: ScriptContext = {
    trigger: "after_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
  };
  await runTriggerScripts("after_post", ctx, doc.id);
  await runRecordFlows({ kind: "after_post" }, doc.kind, doc.id, { orgId: doc.orgId });
  await emitStatusChange(doc.kind, doc.id, { from: previousStatus, to: "posted" }, { orgId: doc.orgId });
}

// ---------------------------------------------------------------------------
// GL Impact as a derived projection.
//
// For a document-sourced entry the DOCUMENT is the system of record; its
// journal entry is a derived projection — entry = postingRules(document) —
// re-materialized on every save (source platform's model). `postDocument` above is
// the first materialization; `regenerateGlImpactTx` re-materializes a posted
// document's entry in place after an edit. A non-GL edit (memo, reference #)
// produces an identical projection and is a no-op on the ledger; a GL edit
// produces a different projection and regenerates the entry's lines, blocked
// only if the posting period is closed.
// ---------------------------------------------------------------------------

/** Raised when a GL-affecting edit would land in a closed accounting period. */
export class ClosedPeriodError extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function glProjectionScopeUnchanged(
  existing: { periodId: string; postingDate: string },
  next: { periodId: string; postingDate: string },
): boolean {
  return existing.periodId === next.periodId && existing.postingDate === next.postingDate;
}

/** Build + validate the GL-Impact projection (kernel lines) for a document. */
function buildProjection(doc: Doc, lines: DocLine[], deps: PostingDeps): KernelLine[] {
  const rule = RULES[doc.kind];
  if (!rule) throw new PostingError(`no posting rule for document kind "${doc.kind}"`);
  const kl = rule(doc, lines, deps).filter((l) => !isZero(l.amount));
  if (kl.length < 2) throw new PostingError("posting produced fewer than 2 lines");
  if (!isZero(sum(kl.map((l) => l.amount)))) {
    throw new PostingError(`posting rule for ${doc.kind} does not balance`);
  }
  // Same AR/AP faithfulness guard as postDocument (this path runs on amend /
  // re-materialization): an open-item leg must carry its subledger party.
  const orphan = kl.find((l) => l.isOpenItem && !l.partyId);
  if (orphan) {
    throw new PostingError(
      `open-item line on account ${orphan.accountId} has no party — every AR/AP line must carry its customer/vendor (line entity)`,
    );
  }
  return kl;
}

/** Stable comparison key for a set of GL lines (order-sensitive, amount-normalized). */
function glKey(
  lines: {
    accountId: string;
    amount: string;
    subsidiaryId?: string | null;
    partyId?: string | null;
    departmentId?: string | null;
    projectId?: string | null;
    locationId?: string | null;
    classId?: string | null;
    equipmentUnitId?: string | null;
    extraDims?: Record<string, string> | null;
    taxCodeId?: string | null;
    paymentCardId?: string | null;
    dueDate?: string | null;
    isOpenItem?: boolean | null;
  }[],
): string {
  return JSON.stringify(
    lines.map((l) => [
      l.accountId,
      toUnits(l.amount).toString(),
      l.subsidiaryId ?? null,
      l.partyId ?? null,
      l.departmentId ?? null,
      l.projectId ?? null,
      l.locationId ?? null,
      l.classId ?? null,
      l.equipmentUnitId ?? null,
      JSON.stringify(Object.fromEntries(Object.entries(l.extraDims ?? {}).sort(([a], [b]) => a.localeCompare(b)))),
      l.taxCodeId ?? null,
      l.paymentCardId ?? null,
      l.dueDate ?? null,
      !!l.isOpenItem,
    ]),
  );
}

/**
 * Re-materialize a POSTED document's GL-Impact projection in place, from its
 * (already-updated) source document + lines, inside the caller's transaction.
 * The caller MUST have run `set local openbooks.amend = on`.
 *
 * Returns `{ changed: false }` when the projection is unchanged (a non-GL edit)
 * — no ledger write happens, so it is allowed even in a closed period. When the
 * projection differs it regenerates the entry's lines in place (the entry keeps
 * its id and stays posted) and throws `ClosedPeriodError` if the old or new
 * period is closed.
 */
export async function regenerateGlImpactTx(
  tx: Tx,
  documentId: string,
  deps: PostingDeps,
  _userId: string,
): Promise<{ entryId: string | null; changed: boolean }> {
  const [doc] = await tx.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  // Only posted documents have a materialized projection to regenerate.
  if (doc.status !== "posted" || !doc.postedEntryId) return { entryId: null, changed: false };

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await tx
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, doc.paymentCardId));
    if (card) deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }
  if ((doc.kind === "journal" || doc.kind === "deposit") && !deps.openItemAccountIds) {
    deps = { ...deps, openItemAccountIds: await resolveOpenItemAccounts(tx, doc.orgId) };
  }
  if (!deps.taxCollectedByCode && doc.kind !== "journal") {
    const tax = await resolveTaxAccounts(tx, doc.orgId);
    deps = { ...deps, taxCollectedByCode: tax.collected, taxPaidByCode: tax.paid };
  }
  if (!deps.taxComponentsByLine && doc.kind !== "journal") {
    deps = { ...deps, taxComponentsByLine: await resolveTaxComponents(tx, doc.id) };
  }
  if (doc.kind === "customer_invoice" && !deps.deferralAccountByLine) {
    deps = { ...deps, deferralAccountByLine: await resolveDeferralAccounts(tx, doc.id) };
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = { ...deps, inventoryAssetByLine: await resolveBillInventoryAccounts(tx, doc.orgId, doc.id) };
  }

  const lines = await tx
    .select()
    .from(schema.documentLines)
    .where(eq(schema.documentLines.documentId, documentId))
    .orderBy(asc(schema.documentLines.lineNumber));

  const projection = buildProjection(doc, lines, deps);
  const { lines: kernelLines, docSubId } = await applySubsidiaries(tx, doc, projection);
  assertFinalKernelBalance(kernelLines);
  await validateRequiredDimensions(tx, doc.orgId, kernelLines);
  const postingDate = doc.postingDate ?? doc.documentDate;

  const periodRes = (await tx.execute(sql`
    select id from accounting_periods
     where org_id = ${doc.orgId} and starts_on <= ${postingDate} and ends_on >= ${postingDate}
       and is_adjustment = false
     limit 1`)) as unknown as { rows: { id: string }[] };
  const period = periodRes.rows[0];
  if (!period) throw new PostingError(`no accounting period covers ${postingDate}`);

  const [entry] = await tx
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, doc.postedEntryId));
  const existing = await tx
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entry.id))
    .orderBy(asc(schema.journalLines.lineNumber));

  // Memo is business metadata, not accounting impact. A memo-only source edit
  // updates the audited document but never rewrites closed ledger evidence.
  // Same lines + posting scope means the GL projection is unchanged.
  const unchanged =
    glProjectionScopeUnchanged(
      { periodId: entry.periodId, postingDate: entry.postingDate },
      { periodId: period.id, postingDate },
    ) &&
    glKey(kernelLines) === glKey(existing as unknown as Parameters<typeof glKey>[0]);
  if (unchanged) return { entryId: entry.id, changed: false };

  // GL projection changed → both its old and new book/entity scopes must be open.
  try {
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: period.id,
      bookId: entry.bookId,
      subsidiaryIds: kernelLines.map((line) => line.subsidiaryId),
      modules: [closeModuleForDocument(doc.kind)],
      allowImportedLocks: deps.migration,
    });
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: entry.periodId,
      bookId: entry.bookId,
      subsidiaryIds: existing.map((line) => line.subsidiaryId),
      modules: [closeModuleForDocument(doc.kind)],
      allowImportedLocks: deps.migration,
    });
  } catch (error) {
    if (error instanceof CloseError) throw new ClosedPeriodError(error.message);
    throw error;
  }

  // Regenerate the entry's lines IN PLACE, preserving line identity so payment
  // applications and bank-reconciliation matches (which FK to journal_line ids)
  // stay linked. Overlapping lines are UPDATEd by position; extra new lines are
  // inserted; surplus old lines are deleted (a delete of a still-referenced line
  // FK-fails and rolls the whole edit back — you can't drop an applied line).
  const vals = (
    l: KernelLine & { subsidiaryId: string; currency: string; txnAmount: string; fxRate: string },
    i: number,
  ) => ({
    orgId: doc.orgId,
    entryId: entry.id,
    lineNumber: i + 1,
    accountId: l.accountId,
    subsidiaryId: l.subsidiaryId,
    amount: l.amount,
    currency: l.currency,
    txnAmount: l.txnAmount,
    fxRate: l.fxRate,
    partyId: l.partyId ?? null,
    departmentId: l.departmentId ?? null,
    projectId: l.projectId ?? null,
    locationId: l.locationId ?? null,
    classId: l.classId ?? null,
    equipmentUnitId: l.equipmentUnitId ?? null,
    extraDims: l.extraDims ?? {},
    paymentCardId: l.paymentCardId ?? null,
    taxCodeId: l.taxCodeId ?? null,
    memo: l.memo ?? null,
    dueDate: l.dueDate ?? null,
    isOpenItem: l.isOpenItem ?? false,
  });
  // Park every existing line out of the (entry_id, line_number) namespace
  // first: when the regenerated projection reorders or renumbers lines, the
  // per-position updates below would otherwise collide with a not-yet-updated
  // sibling's line_number.
  await tx.execute(
    sql`update journal_lines set line_number = line_number + 100000 where entry_id = ${entry.id}`,
  );
  const overlap = Math.min(existing.length, kernelLines.length);
  for (let i = 0; i < overlap; i++) {
    const { orgId: _o, entryId: _e, ...set } = vals(kernelLines[i]!, i);
    await tx.update(schema.journalLines).set(set).where(eq(schema.journalLines.id, existing[i]!.id));
  }
  if (kernelLines.length > existing.length) {
    await tx
      .insert(schema.journalLines)
      .values(kernelLines.slice(existing.length).map((l, k) => vals(l, existing.length + k)));
  } else if (existing.length > kernelLines.length) {
    for (let i = kernelLines.length; i < existing.length; i++) {
      await tx.delete(schema.journalLines).where(eq(schema.journalLines.id, existing[i]!.id));
    }
  }
  await tx
    .update(schema.journalEntries)
    .set({ postingDate, periodId: period.id, memo: doc.memo, subsidiaryId: docSubId })
    .where(eq(schema.journalEntries.id, entry.id));

  return { entryId: entry.id, changed: true };
}
