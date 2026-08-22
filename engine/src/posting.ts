import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, inDbTransaction, schema } from "./db.ts";
import {
  add,
  cmp,
  isZero,
  mulRate,
  neg,
  normalizeDecimal,
  sum,
  toUnits,
} from "./money.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";
import { emitStatusChange, runRecordFlows } from "./flows/run.ts";
import {
  intercompanyBalancingLegs,
  loadSubsidiaryContext,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
} from "./subsidiaries.ts";
import {
  assertPeriodModulesOpen,
  closeModuleForDocument,
  CloseError,
} from "./close.ts";
import {
  applyInventoryIssuesForInvoice,
  applyInventoryReceiptsForBill,
  resolveBillInventoryAccounts,
} from "./inventory.ts";
import { createObligationsFromInvoice } from "./revenue-recognition.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "./transaction-audit.ts";
import { assertBillPostingAllowed, ComplianceError } from "./compliance.ts";

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

export interface SourceCorrectionAuthorization {
  /** Active organization user who explicitly authorized the bounded repair. */
  actorId: string;
  /** Immutable sync-run/request identity tying the ledger chain to its evidence. */
  requestId: string;
  /** Human-readable business reason retained with the correction chain. */
  reason: string;
  /**
   * A running connector mirror may need to reproduce an upstream historical
   * correction inside a period OpenBooks has since closed.  This mode is not a
   * caller-trusted close override: the database validates requestId + actorId
   * against the active sync run and the connection's controller-authorized
   * append-only policy before any closed-period ledger write can occur.
   */
  replayMode?: "authenticated_connector_historical_replay";
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
  orgId: string,
): Promise<Map<string, string>> {
  const r = (await runner.execute<{ line_id: string; deferred_account_id: string }>(sql`
    select dl.id as line_id,
           coalesce(it.deferred_account_id, r.deferred_account_id) as deferred_account_id
      from document_lines dl
      join items it on it.id = dl.item_id and it.org_id = dl.org_id and it.recognition_rule_id is not null
      join recognition_rules r on r.id = it.recognition_rule_id and r.org_id = it.org_id
     where dl.document_id = ${documentId}
       and dl.org_id = ${orgId}
       and coalesce(it.deferred_account_id, r.deferred_account_id) is not null`));
  const map = new Map<string, string>();
  for (const row of r.rows) map.set(row.line_id, row.deferred_account_id);
  return map;
}

/** tax code id → its own collected/paid control accounts, when configured. */
async function resolveTaxAccounts(
  runner: Pick<typeof db, "execute">,
  orgId: string,
): Promise<{ collected: Map<string, string>; paid: Map<string, string> }> {
  const r = (await runner.execute<{
      id: string;
      collected_account_id: string | null;
      paid_account_id: string | null;
    }>(sql`
    select id, collected_account_id, paid_account_id from tax_codes
     where org_id = ${orgId} and (collected_account_id is not null or paid_account_id is not null)`));
  const collected = new Map<string, string>();
  const paid = new Map<string, string>();
  for (const row of r.rows) {
    if (row.collected_account_id)
      collected.set(row.id, row.collected_account_id);
    if (row.paid_account_id) paid.set(row.id, row.paid_account_id);
  }
  return { collected, paid };
}

async function resolveTaxComponents(
  runner: Pick<typeof db, "execute">,
  documentId: string,
  orgId: string,
): Promise<Map<string, TaxPostingComponent[]>> {
  const result = (await runner.execute<Record<string, any>>(sql`
    select c.document_line_id, c.tax_code_id, c.sequence, c.tax_amount::text,
           c.recoverable_amount::text, c.nonrecoverable_amount::text,
           c.calculation_type, c.collected_account_id, c.paid_account_id,
           c.withholding_account_id
      from document_line_tax_components c
      join document_lines dl on dl.id = c.document_line_id and dl.org_id = c.org_id
     where dl.document_id = ${documentId}
       and dl.org_id = ${orgId}
     order by c.document_line_id, c.sequence
  `));
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
  if (!cardLiability)
    throw new PostingError("card_charge requires a payment card");
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

/**
 * Tax-control legs settle an amount with a tax authority; they are not
 * project cost or revenue. Nonrecoverable purchase tax is already capitalized
 * into the originating detail line by purchaseBaseAmount, so carrying the
 * project onto the recoverable/output control leg would double-state project
 * activity in balance-sheet categories. Preserve the other analytical context
 * for statutory reporting, but explicitly clear project/equipment dimensions.
 */
const taxControlDims = (d: Doc, l: DocLine) => ({
  departmentId: l.departmentId ?? d.departmentId,
  projectId: null,
  locationId: l.locationId ?? d.locationId,
  classId: l.classId ?? d.classId,
  equipmentUnitId: null,
  extraDims: {
    ...((d.extraDims ?? {}) as Record<string, string>),
    ...((l.extraDims ?? {}) as Record<string, string>),
  },
});

/** Pure GL projection for a financial equipment/resource charge. The debit is
 * job cost; the credit relieves a distinct recovery pool. Keeping this helper
 * exported makes the accounting invariant directly testable. */
export function projectChargeKernelLines(
  doc: Doc,
  lines: DocLine[],
): KernelLine[] {
  const out: KernelLine[] = [];
  for (const line of lines) {
    if (!line.accountId)
      throw new PostingError("project charge requires a cost account");
    if (!line.recoveryAccountId)
      throw new PostingError("project charge requires a cost recovery account");
    if (line.recoveryAccountId === line.accountId) {
      throw new PostingError(
        "project charge cost and recovery accounts must be different",
      );
    }
    out.push({
      accountId: line.accountId,
      amount: line.amount,
      memo: line.description,
      ...dims(doc, line),
    });
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
  const rows = (await runner.execute<{
      id: string;
      number: string | null;
      name: string;
      required_dimensions: string[];
      segment_names: Record<string, string>;
    }>(sql`
    select a.id, a.number, a.name, a.required_dimensions,
           coalesce(jsonb_object_agg(sd.key, sd.name) filter (where sd.key is not null), '{}'::jsonb) as segment_names
      from accounts a
      left join segment_definitions sd on sd.org_id = a.org_id and sd.is_active
     where a.org_id = ${orgId}
       and a.id = any(${`{${accountIds.join(",")}}`}::uuid[])
     group by a.id
  `));
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
        const label =
          account?.segment_names?.[key] ?? (key === "party" ? "Party" : key);
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
  const standard = sum(
    components
      .filter((c) => c.calculationType === "standard")
      .map((c) => c.taxAmount),
  );
  const withholding = sum(
    components
      .filter((c) => c.calculationType === "withholding")
      .map((c) => c.taxAmount),
  );
  return add(standard, neg(withholding));
}

function componentsForLine(
  line: DocLine,
  deps: PostingDeps,
): TaxPostingComponent[] {
  const components = deps.taxComponentsByLine?.get(line.id) ?? [];
  const hasTaxProfile = Boolean(line.taxCodeId || line.taxGroupId);
  if (hasTaxProfile && components.length === 0) {
    throw new PostingError(
      `line ${line.lineNumber} has a tax profile but no calculation evidence`,
    );
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
      const common = {
        taxCodeId: component.taxCodeId,
        partyId: line.partyId ?? doc.partyId,
        ...taxControlDims(doc, line),
      };
      if (component.calculationType === "withholding") {
        if (!component.withholdingAccountId) {
          throw new PostingError(
            `withholding tax ${component.taxCodeId} has no withholding account`,
          );
        }
        out.push({
          ...common,
          accountId: component.withholdingAccountId,
          amount: signed(neg(component.taxAmount), direction),
        });
        continue;
      }
      if (!isZero(component.recoverableAmount)) {
        out.push({
          ...common,
          accountId:
            component.paidAccountId ??
            deps.taxPaidByCode?.get(component.taxCodeId) ??
            deps.control.taxPaid ??
            deps.control.ap,
          amount: signed(component.recoverableAmount, direction),
        });
      }
      if (
        component.calculationType === "reverse_charge" &&
        !isZero(component.taxAmount)
      ) {
        out.push({
          ...common,
          accountId:
            component.collectedAccountId ??
            deps.taxCollectedByCode?.get(component.taxCodeId) ??
            deps.control.taxCollected ??
            deps.control.ap,
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
      const common = {
        taxCodeId: component.taxCodeId,
        partyId: line.partyId ?? doc.partyId,
        ...taxControlDims(doc, line),
      };
      if (component.calculationType === "reverse_charge") continue;
      if (component.calculationType === "withholding") {
        if (!component.withholdingAccountId) {
          throw new PostingError(
            `withholding tax ${component.taxCodeId} has no withholding account`,
          );
        }
        out.push({
          ...common,
          accountId: component.withholdingAccountId,
          amount: signed(component.taxAmount, direction),
        });
      } else {
        out.push({
          ...common,
          accountId:
            component.collectedAccountId ??
            deps.taxCollectedByCode?.get(component.taxCodeId) ??
            deps.control.taxCollected ??
            deps.control.ar,
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
    const discount =
      typeof custom.discountAmount === "string" ? custom.discountAmount : "0";
    const discountAccountId =
      typeof custom.discountAccountId === "string"
        ? custom.discountAccountId
        : null;
    if (toUnits(discount) < 0n)
      throw new Error("vendor payment discount cannot be negative");
    if (!isZero(discount) && !discountAccountId)
      throw new Error("vendor payment discount account is required");
    const payable = add(cash, discount);
    return [
      // The AP leg is an OPEN ITEM: it settles against the bills it paid, so it
      // must carry is_open_item to be a valid application source (from_line).
      // controlOverride: a payment against a non-default payable account (a
      // financing sub-account, or a source system with several AP accounts).
      {
        accountId: controlOverride(doc) ?? deps.control.ap,
        amount: payable,
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      }, // debit AP
      {
        accountId: lines[0]?.accountId ?? deps.control.bank,
        amount: neg(cash),
        ...dims(doc),
      }, // credit bank
      ...(!isZero(discount)
        ? [
            {
              accountId: discountAccountId!,
              amount: neg(discount),
              partyId: doc.partyId,
              ...dims(doc),
            },
          ]
        : []),
    ];
  },

  customer_payment: (doc, lines, deps) => {
    const total = sum(lines.map(lineTotal));
    const custom = (doc.custom ?? {}) as Record<string, unknown>;
    // Optional payment-acceptance surcharge: the customer was charged
    // total = invoice portion + fee; the fee leg credits a fee-income account
    // instead of AR, so the AR leg cross-foots to the open-item applications.
    const fee = typeof custom.feeAmount === "string" ? custom.feeAmount : "0";
    const feeAccountId =
      typeof custom.feeIncomeAccountId === "string"
        ? custom.feeIncomeAccountId
        : null;
    if (toUnits(fee) < 0n)
      throw new Error("customer payment fee cannot be negative");
    if (cmp(fee, total) > 0)
      throw new Error("customer payment fee exceeds the receipt");
    if (!isZero(fee) && !feeAccountId)
      throw new Error("customer payment fee income account is required");
    const receivable = add(total, neg(fee));
    return [
      {
        accountId: lines[0]?.accountId ?? deps.control.bank,
        amount: total,
        ...dims(doc),
      }, // debit bank
      // The AR leg is an OPEN ITEM: it settles the invoices it paid (from_line).
      {
        accountId: controlOverride(doc) ?? deps.control.ar,
        amount: neg(receivable),
        partyId: doc.partyId,
        isOpenItem: true,
        ...dims(doc),
      }, // credit AR
      ...(!isZero(fee)
        ? [{ accountId: feeAccountId!, amount: neg(fee), ...dims(doc) }]
        : []), // credit fee income
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
    const controlAccountId =
      controlOverride(doc) ??
      deps.control.employeePayable ??
      deps.control.ap;
    return [
      ...expense,
      ...tax,
      {
        accountId: controlAccountId,
        amount: neg(total),
        partyId: doc.partyId,
        // Expense reports can be charged directly to a corporate-card
        // liability. Only a genuine AR/AP control account belongs in aging;
        // card liabilities remain GL/card-subledger balances.
        isOpenItem: controlLineIsOpenItem(
          controlAccountId,
          doc.partyId,
          deps.openItemAccountIds,
        ),
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
        isOpenItem: controlLineIsOpenItem(
          l.accountId!,
          partyId,
          deps.openItemAccountIds,
        ),
        ...dims(doc, l),
      };
    }),

  /**
   * Pay run: the committed payroll GL projection. commitPayRun materialized a
   * balanced, signed line set (DR wages/burden, CR withholding liabilities and
   * per-employee net pay) — the rule maps it 1:1 like a journal. Employee
   * parties ride the net-pay legs so the payable can settle per person.
   */
  pay_run: (doc, lines) =>
    lines.map((l) => {
      if (!l.accountId) throw new PostingError("pay run line is missing an account");
      const partyId = l.partyId ?? null;
      return {
        accountId: l.accountId,
        amount: l.amount,
        memo: l.description,
        partyId,
        // commitPayRun puts a party ONLY on the per-employee net-pay legs —
        // those are open items by construction (settled by the payment
        // journal), regardless of the payable account's configured type.
        isOpenItem: partyId != null,
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
        isOpenItem: controlLineIsOpenItem(
          l.accountId!,
          partyId,
          deps.openItemAccountIds,
        ),
        ...dims(doc, l),
      };
    });
    const total = sum(lines.map((l) => l.amount)); // positive = money in
    return [
      {
        accountId: controlOverride(doc) ?? deps.control.bank,
        amount: total,
        ...dims(doc),
      }, // debit bank
      ...sources,
    ];
  },

  /** Transfer: DR one account, CR another, equal amounts (line 0 = to, line 1 = from). */
  transfer: (doc, lines, deps) => {
    const total = sum(lines.map((l) => l.amount));
    return [
      {
        accountId: lines[0]?.accountId ?? deps.control.bank,
        amount: total,
        ...dims(doc),
      }, // debit destination
      {
        accountId: lines[1]?.accountId ?? deps.control.bank,
        amount: neg(total),
        ...dims(doc),
      }, // credit source
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
  if (lines.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(lines.map((line) => line.amount));
  if (!isZero(total))
    throw new PostingError(
      `functional-currency journal does not balance (sum=${total})`,
    );
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
  // Open-item capability follows from control designation, not only from
  // account type: the industry presets wire the employee-reimbursements
  // control (settings.controlAccounts.employeePayable) to a
  // liability_current_other account, and an expense report's control line
  // must still be an open item there or it can never be settled through the
  // payment-application engine.
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounts
     where org_id = ${orgId} and type in ('asset_receivable', 'liability_payable')
    union
    select (settings->'controlAccounts'->>'employeePayable')::uuid as id
      from orgs
     where id = ${orgId}
       and settings->'controlAccounts'->>'employeePayable' is not null`));
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
  lines: (KernelLine & {
    subsidiaryId: string;
    currency: string;
    txnAmount: string;
    fxRate: string;
  })[];
  docSubId: string;
  multi: boolean;
  /** The origin subsidiary's functional currency. */
  originBaseCurrency: string;
  /**
   * The txn→origin-functional rate this run resolved and applied to every
   * origin-subsidiary leg (the document's stored rate when it carries one,
   * "1" when the document is already in the origin's base currency).
   */
  originFxRate: string;
}> {
  try {
    const ctx = await loadSubsidiaryContext(runner, doc.orgId);
    const docSubId = doc.subsidiaryId ?? ctx.rootId;
    const origin = ctx.byId.get(docSubId);
    if (!origin)
      throw new SubsidiaryError(`subsidiary ${docSubId} does not exist`);
    const postingDate = doc.postingDate ?? doc.documentDate;
    const rateCache = new Map<string, string>();

    const functionalRate = async (targetCurrency: string): Promise<string> => {
      if (doc.currency === targetCurrency) return "1";
      // Honour a user-supplied header rate. The schema default is '1', which
      // on a foreign-currency document is "unset", not a 1:1 peg — look the
      // spot up so dunning, payment runs and the stamp are not all 1.
      if (targetCurrency === origin.baseCurrency && doc.fxRate && doc.fxRate !== "1") {
        return doc.fxRate;
      }
      const cached = rateCache.get(targetCurrency);
      if (cached) return cached;
      const r = (await runner.execute<{ rate: string }>(sql`
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
        ) candidates order by as_of desc limit 1`));
      const rate = r.rows[0]?.rate;
      if (!rate) {
        throw new SubsidiaryError(
          `no spot rate for ${doc.currency}→${targetCurrency} on or before ${postingDate}`,
        );
      }
      rateCache.set(targetCurrency, rate);
      return rate;
    };

    // The runner can be a transaction-scoped database handle backed by one
    // PostgreSQL client. Resolve rates in a deterministic sequence instead of
    // issuing concurrent queries on that client. This also makes the cache
    // authoritative when several lines share a target currency.
    const stamped: (KernelLine & {
      subsidiaryId: string;
      currency: string;
      txnAmount: string;
      fxRate: string;
    })[] = [];
    for (const line of kernelLines) {
      const subsidiaryId = line.subsidiaryId ?? docSubId;
      const subsidiary = ctx.byId.get(subsidiaryId);
      if (!subsidiary)
        throw new SubsidiaryError(`subsidiary ${subsidiaryId} does not exist`);
      const fxRate = await functionalRate(subsidiary.baseCurrency);
      stamped.push({
        ...line,
        subsidiaryId,
        amount: mulRate(line.amount, fxRate),
        currency: doc.currency,
        txnAmount: line.amount,
        fxRate,
      });
    }
    const originFxRate = await functionalRate(origin.baseCurrency);
    const legs = await intercompanyBalancingLegs(runner, {
      orgId: doc.orgId,
      ctx,
      originSubId: docSubId,
      originFxRate,
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
    return {
      lines: all,
      docSubId,
      multi: new Set(all.map((l) => l.subsidiaryId)).size > 1,
      originBaseCurrency: origin.baseCurrency,
      originFxRate,
    };
  } catch (err) {
    if (err instanceof SubsidiaryError) throw new PostingError(err.message);
    throw err;
  }
}

/**
 * Resolve the authoritative accounting period independently from transaction
 * date when the document carries an explicit override. This is required for
 * late postings and adjustment periods; the composite database FK guarantees
 * the selected period belongs to the same organization.
 */
async function resolvePostingPeriod(
  runner: Pick<typeof db, "execute">,
  doc: Doc,
  postingDate: string,
): Promise<{ id: string }> {
  const periodRes = doc.postingPeriodId
    ? ((await runner.execute<{ id: string }>(sql`
        select id
          from accounting_periods
         where id = ${doc.postingPeriodId}
           and org_id = ${doc.orgId}
         limit 1
      `)))
    : ((await runner.execute<{ id: string }>(sql`
        select id
          from accounting_periods
         where org_id = ${doc.orgId}
           and starts_on <= ${postingDate}
           and ends_on >= ${postingDate}
           and is_adjustment = false
         limit 1
      `)));
  const period = periodRes.rows[0];
  if (!period) {
    throw new PostingError(
      doc.postingPeriodId
        ? `accounting period ${doc.postingPeriodId} is not available for this organization`
        : `no accounting period covers ${postingDate}`,
    );
  }
  return period;
}

export async function postDocument(
  documentId: string,
  deps: PostingDeps,
  options: {
    deferEffects?: boolean;
    /** Source-authoritative replay runs the accounting kernel and product
     * subledgers without re-firing tenant-authored UI scripts or flows. */
    suppressAutomation?: boolean;
    audit?: { actorId: string | null; source: string };
  } = {},
): Promise<string> {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  if (doc.status === "posted")
    throw new PostingError(`document ${doc.documentNumber} already posted`);
  if (doc.status === "voided")
    throw new PostingError(`document ${doc.documentNumber} is voided`);
  if (doc.status !== "approved") {
    throw new PostingError(
      `document ${doc.documentNumber} is ${doc.status}; it must complete the approval submission lifecycle before posting`,
    );
  }
  if (
    (doc.kind === "journal" ||
      doc.kind === "deposit" ||
      doc.kind === "expense_report") &&
    !deps.openItemAccountIds
  ) {
    deps = {
      ...deps,
      openItemAccountIds: await resolveOpenItemAccounts(db, doc.orgId),
    };
  }
  if (!deps.taxCollectedByCode && doc.kind !== "journal") {
    const tax = await resolveTaxAccounts(db, doc.orgId);
    deps = {
      ...deps,
      taxCollectedByCode: tax.collected,
      taxPaidByCode: tax.paid,
    };
  }
  if (!deps.taxComponentsByLine && doc.kind !== "journal") {
    deps = {
      ...deps,
      taxComponentsByLine: await resolveTaxComponents(db, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "customer_invoice" && !deps.deferralAccountByLine) {
    deps = {
      ...deps,
      deferralAccountByLine: await resolveDeferralAccounts(db, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = {
      ...deps,
      inventoryAssetByLine: await resolveBillInventoryAccounts(
        db,
        doc.orgId,
        doc.id,
      ),
    };
  }

  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(and(eq(schema.documentLines.documentId, documentId), eq(schema.documentLines.orgId, doc.orgId)))
    .orderBy(asc(schema.documentLines.lineNumber));

  const rule = RULES[doc.kind];
  if (!rule)
    throw new PostingError(`no posting rule for document kind "${doc.kind}"`);

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await db
      .select()
      .from(schema.paymentCards)
      .where(and(eq(schema.paymentCards.id, doc.paymentCardId), eq(schema.paymentCards.orgId, doc.orgId)));
    if (card)
      deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, doc.orgId));
  const scriptCtx: ScriptContext = {
    trigger: "before_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
  };

  // -- user scripts: before_post (veto / mutate) --------------------------
  const outcomes = options.suppressAutomation
    ? []
    : await runTriggerScripts("before_post", scriptCtx, doc.id);
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
      .where(and(eq(schema.documents.id, doc.id), eq(schema.documents.orgId, doc.orgId)))
      .returning();
    effectiveDoc = updated;
  }

  // -- flows: before_post (automation only, never a veto) ------------------
  // A before_post flow may set_field whitelisted headers; re-read the
  // document so its projection reflects them.
  const beforePostFlows = options.suppressAutomation
    ? { runs: [], gatesCreated: 0, failed: false }
    : await runRecordFlows(
        { kind: "before_post" },
        doc.kind,
        doc.id,
        {
          orgId: doc.orgId,
        },
      );
  if (beforePostFlows.gatesCreated > 0 || beforePostFlows.failed) {
    const runIds = beforePostFlows.runs.map((run) => run.runId);
    if (runIds.length > 0) {
      await db
        .update(schema.flowGates)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            inArray(schema.flowGates.runId, runIds),
            eq(schema.flowGates.orgId, doc.orgId),
            inArray(schema.flowGates.status, ["pending", "escalated"]),
          ),
        );
      await db
        .update(schema.flowRuns)
        .set({
          status: "failed",
          error: beforePostFlows.failed
            ? "before-post automation failed"
            : "approval gates must be configured on on_submit",
          finishedAt: new Date(),
        })
        .where(and(inArray(schema.flowRuns.id, runIds), eq(schema.flowRuns.orgId, doc.orgId)));
    }
    throw new PostingError(
      beforePostFlows.failed
        ? "a before-post flow failed; posting stopped"
        : "before-post approval gates are not a posting release — configure approval gates on on_submit",
    );
  }
  if (beforePostFlows.runs.length > 0) {
    const [refreshed] = await db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.id, doc.id), eq(schema.documents.orgId, doc.orgId)));
    if (refreshed) effectiveDoc = refreshed;
  }

  // -- build + validate kernel lines --------------------------------------
  const kernelLines = rule(effectiveDoc, lines, deps).filter(
    (l) => !isZero(l.amount),
  );
  if (kernelLines.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(kernelLines.map((l) => l.amount));
  if (!isZero(total)) {
    throw new PostingError(
      `posting rule for ${doc.kind} does not balance (sum=${total})`,
    );
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

  // -- subcontractor compliance: block_bill requirements -------------------
  // A vendor bill for a subcontractor whose insurance/licence has lapsed under a
  // `block_bill` policy cannot be recorded at all. Enforced here, in the kernel,
  // so no import, script, or API route can route around it. Migration posts are
  // exempt: historical books are reproduced as they were, not re-adjudicated.
  if (
    !deps.migration &&
    effectiveDoc.partyId &&
    (effectiveDoc.kind === "vendor_bill" ||
      effectiveDoc.kind === "expense_report")
  ) {
    try {
      await assertBillPostingAllowed({
        orgId: doc.orgId,
        partyId: effectiveDoc.partyId,
        projectId: effectiveDoc.projectId ?? null,
        documentNumber: effectiveDoc.documentNumber,
        asOf: effectiveDoc.postingDate ?? effectiveDoc.documentDate,
      });
    } catch (error) {
      if (error instanceof ComplianceError)
        throw new PostingError(error.message);
      throw error;
    }
  }

  if (
    !deps.migration &&
    effectiveDoc.partyId &&
    effectiveDoc.kind === "customer_invoice"
  ) {
    const hold = (await db.execute<{ hold_reason: string | null }>(sql`
      select hold_reason
        from customer_roles
       where org_id = ${effectiveDoc.orgId} and party_id = ${effectiveDoc.partyId}
         and is_active and is_on_hold
       limit 1
    `));
    if (hold.rows[0]) {
      throw new PostingError(
        `customer is on credit hold${hold.rows[0].hold_reason ? ` — ${hold.rows[0].hold_reason}` : ""}`,
      );
    }
  }

  // -- subsidiaries: stamp, intercompany-balance, validate restrictions ----
  const subApplied = await applySubsidiaries(db, effectiveDoc, kernelLines);
  assertFinalKernelBalance(subApplied.lines);
  await validateRequiredDimensions(db, doc.orgId, subApplied.lines);

  const postingDate = effectiveDoc.postingDate ?? effectiveDoc.documentDate;
  const period = await resolvePostingPeriod(db, effectiveDoc, postingDate);

  const [book] = await db
    .select()
    .from(schema.accountingBooks)
    .where(
      sql`${schema.accountingBooks.orgId} = ${doc.orgId} and ${schema.accountingBooks.isPrimary} = true`,
    );
  if (!book)
    throw new PostingError("primary accounting book is not configured");
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
    if (deps.migration)
      await tx.execute(sql`set local openbooks.migration = on`);
    const auditBefore = options.audit
      ? await captureTransactionAuditSnapshot(tx, documentId, doc.orgId)
      : null;
    if (options.audit && !auditBefore) {
      throw new PostingError(
        `document ${documentId} disappeared before posting`,
      );
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
      .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.orgId, doc.orgId)));

    // Exactly-once posting, serialized at the aggregate root: the flip only
    // lands while the document is still unposted. Postgres row-locks the
    // document during this UPDATE, so a concurrent post blocks here, then
    // re-evaluates the predicate against the now-'posted' row and matches 0
    // rows. Zero rows → throw → THIS transaction rolls back, discarding the
    // entry + lines just inserted. A document can never produce two entries.
    //
    // The flip also stamps documents.fx_rate with the SAME rate the kernel
    // applied to the origin-subsidiary legs, in the same transaction as the
    // entry, so the header and the posted lines agree by construction:
    // documents.fx_rate is the txn→functional rate as of posting, maintained
    // by the posting kernel. Native creation paths never set it (the column
    // defaults to '1'; only source sync wrote real values before), so every
    // downstream reader — dunning's base-currency threshold, payment-run
    // conversions — now reads the rate the ledger actually posted at. A
    // document already in its origin's base currency keeps the stored value
    // (1 by definition). The posted-document financial guard is not in play
    // here: this UPDATE matches only 'approved' rows and that guard fires
    // solely for posted/reversed ones.
    const flipped = await tx
      .update(schema.documents)
      .set({
        status: "posted",
        postedEntryId: entry.id,
        postingDate,
        postingPeriodId: period.id,
        ...(subApplied.originBaseCurrency !== effectiveDoc.currency
          ? { fxRate: subApplied.originFxRate }
          : {}),
      })
      .where(
        and(
          eq(schema.documents.id, doc.id),
          eq(schema.documents.orgId, doc.orgId),
          eq(schema.documents.status, "approved"),
        ),
      )
      .returning({ id: schema.documents.id });
    if (flipped.length === 0) {
      throw new PostingError(
        `document ${doc.documentNumber} was already posted or voided`,
      );
    }

    if (options.audit && auditBefore) {
      const auditAfter = await captureTransactionAuditSnapshot(tx, documentId, doc.orgId);
      if (!auditAfter)
        throw new PostingError(
          `document ${documentId} disappeared during posting`,
        );
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

  // Product subledgers are part of posting semantics regardless of whether
  // posting was initiated by the UI, API, a flow action, or a scheduler.
  // Each service is idempotent by document line, so a retry repairs a
  // post-commit interruption without duplicating inventory or obligations.
  const effectActorId = options.audit?.actorId ?? null;
  if (doc.kind === "customer_invoice") {
    await createObligationsFromInvoice(doc.id, doc.orgId, effectActorId);
    if (effectiveDoc.subsidiaryId) {
      await applyInventoryIssuesForInvoice(
        doc.orgId,
        effectActorId,
        doc.id,
        postingDate,
        effectiveDoc.subsidiaryId,
      );
    }
  } else if (doc.kind === "vendor_bill" && effectiveDoc.subsidiaryId) {
    await applyInventoryReceiptsForBill(
      doc.orgId,
      effectActorId,
      doc.id,
      entryId,
      postingDate,
      effectiveDoc.subsidiaryId,
    );
  }

  if (!options.deferEffects && !options.suppressAutomation) {
    await runTriggerScripts(
      "after_post",
      { ...scriptCtx, trigger: "after_post" },
      doc.id,
    );
    // -- flows: after_post + the status transition (never throws) -----------
    await runRecordFlows({ kind: "after_post" }, doc.kind, doc.id, {
      orgId: doc.orgId,
    });
    await emitStatusChange(
      doc.kind,
      doc.id,
      { from: doc.status, to: "posted" },
      { orgId: doc.orgId },
    );
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
  options: { suppressAutomation?: boolean } = {},
): Promise<void> {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc || doc.status !== "posted") return;
  const lines = await db
    .select()
    .from(schema.documentLines)
    .where(and(eq(schema.documentLines.documentId, documentId), eq(schema.documentLines.orgId, doc.orgId)))
    .orderBy(asc(schema.documentLines.lineNumber));
  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, doc.orgId));
  if (!org) return;
  const ctx: ScriptContext = {
    trigger: "after_post",
    document: doc as unknown as Record<string, unknown>,
    lines: lines as unknown as Record<string, unknown>[],
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
  };
  if (!options.suppressAutomation) {
    await runTriggerScripts("after_post", ctx, doc.id);
    await runRecordFlows({ kind: "after_post" }, doc.kind, doc.id, {
      orgId: doc.orgId,
    });
    await emitStatusChange(
      doc.kind,
      doc.id,
      { from: previousStatus, to: "posted" },
      { orgId: doc.orgId },
    );
  }
  if (doc.kind === "customer_payment") {
    const { finalizePaymentAcceptanceForDocument } =
      await import("./payment-acceptance.ts");
    await finalizePaymentAcceptanceForDocument(doc.id);
  }
}

// ---------------------------------------------------------------------------
// Historical source-mirror GL replay.
//
// This is not an interactive edit path. Ordinary posted transactions are
// immutable and use controlled reversal plus a correcting document. The
// projection helper below is retained only for connector-owned historical
// replay, where `deps.migration` is explicit and the source snapshot remains
// the authoritative imported evidence.
// ---------------------------------------------------------------------------

/** Raised when a GL-affecting edit would land in a closed accounting period. */
export class ClosedPeriodError extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function glProjectionScopeUnchanged(
  existing: { periodId: string; postingDate: string },
  next: { periodId: string; postingDate: string },
): boolean {
  return (
    existing.periodId === next.periodId &&
    existing.postingDate === next.postingDate
  );
}

/** Build + validate the GL-Impact projection (kernel lines) for a document. */
function buildProjection(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
): KernelLine[] {
  const rule = RULES[doc.kind];
  if (!rule)
    throw new PostingError(`no posting rule for document kind "${doc.kind}"`);
  const kl = rule(doc, lines, deps).filter((l) => !isZero(l.amount));
  if (kl.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
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
    currency?: string | null;
    txnAmount?: string | null;
    fxRate?: string | null;
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
      JSON.stringify(
        Object.fromEntries(
          Object.entries(l.extraDims ?? {}).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      ),
      l.taxCodeId ?? null,
      l.paymentCardId ?? null,
      l.dueDate ?? null,
      !!l.isOpenItem,
      l.currency ?? null,
      l.txnAmount == null ? null : toUnits(l.txnAmount).toString(),
      l.fxRate == null ? null : normalizeDecimal(l.fxRate, 10),
    ]),
  );
}

/**
 * Re-materialize an imported POSTED document's GL projection during controlled
 * source replay. The caller MUST set `deps.migration` and must have run
 * `set local openbooks.amend = on`.
 *
 * Returns `{ changed: false }` when the projection is unchanged (a non-GL edit)
 * — no ledger write happens, so it is allowed even in a closed period. A
 * changed projection fails closed unless the caller supplies an explicit,
 * attributable `SourceCorrectionAuthorization`. That bounded repair retains
 * the original, appends an exact reversal and replacement, transfers live
 * application evidence, and refuses dependencies that require a dedicated
 * bank, inventory, revenue, or downstream-document workflow.
 */
export async function regenerateGlImpactTx(
  tx: Tx,
  documentId: string,
  deps: PostingDeps,
  _userId: string,
  correction?: SourceCorrectionAuthorization,
): Promise<{ entryId: string | null; changed: boolean }> {
  if (!deps.migration) {
    throw new PostingError(
      "posted GL replay is restricted to controlled historical migration",
    );
  }
  const [doc] = await tx
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, documentId));
  if (!doc) throw new PostingError(`document ${documentId} not found`);
  // Only posted documents have a materialized projection to regenerate.
  if (doc.status !== "posted" || !doc.postedEntryId)
    return { entryId: null, changed: false };

  if (doc.paymentCardId && !deps.cardLiabilityAccountId) {
    const [card] = await tx
      .select()
      .from(schema.paymentCards)
      .where(and(eq(schema.paymentCards.id, doc.paymentCardId), eq(schema.paymentCards.orgId, doc.orgId)));
    if (card)
      deps = { ...deps, cardLiabilityAccountId: card.liabilityAccountId };
  }
  if (
    (doc.kind === "journal" ||
      doc.kind === "deposit" ||
      doc.kind === "expense_report") &&
    !deps.openItemAccountIds
  ) {
    deps = {
      ...deps,
      openItemAccountIds: await resolveOpenItemAccounts(tx, doc.orgId),
    };
  }
  if (!deps.taxCollectedByCode && doc.kind !== "journal") {
    const tax = await resolveTaxAccounts(tx, doc.orgId);
    deps = {
      ...deps,
      taxCollectedByCode: tax.collected,
      taxPaidByCode: tax.paid,
    };
  }
  if (!deps.taxComponentsByLine && doc.kind !== "journal") {
    deps = {
      ...deps,
      taxComponentsByLine: await resolveTaxComponents(tx, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "customer_invoice" && !deps.deferralAccountByLine) {
    deps = {
      ...deps,
      deferralAccountByLine: await resolveDeferralAccounts(tx, doc.id, doc.orgId),
    };
  }
  if (doc.kind === "vendor_bill" && !deps.inventoryAssetByLine) {
    deps = {
      ...deps,
      inventoryAssetByLine: await resolveBillInventoryAccounts(
        tx,
        doc.orgId,
        doc.id,
      ),
    };
  }

  const lines = await tx
    .select()
    .from(schema.documentLines)
    .where(and(eq(schema.documentLines.documentId, documentId), eq(schema.documentLines.orgId, doc.orgId)))
    .orderBy(asc(schema.documentLines.lineNumber));

  const projection = buildProjection(doc, lines, deps);
  const subApplied = await applySubsidiaries(
    tx,
    doc,
    projection,
  );
  const kernelLines = subApplied.lines;
  assertFinalKernelBalance(kernelLines);
  await validateRequiredDimensions(tx, doc.orgId, kernelLines);
  const postingDate = doc.postingDate ?? doc.documentDate;

  const period = await resolvePostingPeriod(tx, doc, postingDate);

  const [entry] = await tx
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.id, doc.postedEntryId), eq(schema.journalEntries.orgId, doc.orgId)));
  if (!entry || entry.status !== "posted") {
    throw new PostingError(
      "the imported document's current journal entry is missing or not posted",
    );
  }
  const existing = await tx
    .select()
    .from(schema.journalLines)
    .where(and(eq(schema.journalLines.entryId, entry.id), eq(schema.journalLines.orgId, doc.orgId)))
    .orderBy(asc(schema.journalLines.lineNumber));

  // Memo is business metadata, not accounting impact. A memo-only source edit
  // updates the audited document but never rewrites closed ledger evidence.
  // Same lines + posting scope means the GL projection is unchanged.
  const unchanged =
    glProjectionScopeUnchanged(
      { periodId: entry.periodId, postingDate: entry.postingDate },
      { periodId: period.id, postingDate },
    ) &&
    glKey(kernelLines) ===
      glKey(existing as unknown as Parameters<typeof glKey>[0]);
  if (unchanged) return { entryId: entry.id, changed: false };

  if (!correction) {
    throw new PostingError(
      "posted GL projection changed; in-place regeneration is forbidden — use a controlled append-only reversal/replacement workflow",
    );
  }

  const reason = correction.reason.trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new PostingError(
      "a source correction reason between 10 and 500 characters is required",
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(correction.actorId)) {
    throw new PostingError(
      "an attributable organization user is required for a source correction",
    );
  }
  if (!correction.requestId.trim()) {
    throw new PostingError("a source correction request identity is required");
  }

  const control = (await tx.execute<{
      actor_valid: boolean;
      already_reversed: boolean;
      reconciled: boolean;
      applied: boolean;
      inventory: boolean;
      revenue: boolean;
      downstream: boolean;
    }>(sql`
    select
      exists (
        select 1 from users
         where id = ${correction.actorId}
           and org_id = ${doc.orgId}
           and is_active
      ) as actor_valid,
      exists (
        select 1 from journal_entries reversal
         where reversal.org_id = ${doc.orgId}
           and reversal.reverses_entry_id = ${entry.id}
           and reversal.status in ('posted', 'reversed')
      ) as already_reversed,
      exists (
        select 1 from reconciliation_matches match
         where match.org_id = ${doc.orgId}
           and match.journal_line_id in (
             select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
           )
      ) as reconciled,
      exists (
        select 1 from applications application
         where application.org_id = ${doc.orgId}
           and application.unapplied_at is null
           and (
             application.from_line_id in (
               select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
             )
             or application.to_line_id in (
               select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
             )
           )
      ) as applied,
      exists (
        select 1 from inventory_movements movement
         where movement.org_id = ${doc.orgId}
           and movement.document_line_id in (
             select id from document_lines where document_id = ${doc.id} and org_id = ${doc.orgId}
           )
      ) as inventory,
      exists (
        select 1 from performance_obligations obligation
         where obligation.org_id = ${doc.orgId}
           and obligation.document_line_id in (
             select id from document_lines where document_id = ${doc.id} and org_id = ${doc.orgId}
           )
           and obligation.status <> 'cancelled'
      ) as revenue,
      exists (
        select 1 from document_links link
         join documents downstream
           on downstream.id = link.to_document_id
          and downstream.org_id = link.org_id
         where link.org_id = ${doc.orgId}
           and link.from_document_id = ${doc.id}
           and link.link_type <> 'pays'
           and downstream.status in ('approved', 'posted')
      ) as downstream
  `));
  const gates = control.rows[0];
  if (!gates?.actor_valid) {
    throw new PostingError(
      "the source correction actor is not an active organization user",
    );
  }
  if (gates.already_reversed) {
    throw new PostingError(
      "the current journal already has a reversal; resolve its existing correction lineage before retrying",
    );
  }
  const blockers = [
    gates.reconciled ? "bank reconciliation" : null,
    gates.inventory ? "inventory movements" : null,
    gates.revenue ? "revenue-recognition obligations" : null,
    gates.downstream ? "downstream documents" : null,
  ].filter((value): value is string => value !== null);
  if (blockers.length > 0) {
    throw new PostingError(
      `source correction is blocked by ${blockers.join(", ")}; reverse or transfer those dependent subledgers first`,
    );
  }

  // Applications are append-preserved settlement evidence. A correction may
  // move the document's open-item line, so retain each old application through
  // its one legal unapply transition and append an equivalent application to
  // the replacement endpoint. Bank reconciliation, inventory, revenue, and
  // downstream-document evidence remain hard blockers because their dedicated
  // transfer/cancellation workflows carry additional accounting semantics.
  const activeApplications = await tx
    .select()
    .from(schema.applications)
    .where(sql`
      ${schema.applications.orgId} = ${doc.orgId}
      and ${schema.applications.unappliedAt} is null
      and (
        ${schema.applications.fromLineId} in (
          select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
        )
        or ${schema.applications.toLineId} in (
          select id from journal_lines where entry_id = ${entry.id} and org_id = ${doc.orgId}
        )
      )
    `);

  let authenticatedHistoricalReplay = false;
  if (
    correction.replayMode === "authenticated_connector_historical_replay"
  ) {
    await tx.execute(sql`
      select
        set_config('openbooks.connector_replay', 'on', true),
        set_config('openbooks.connector_replay_request', ${correction.requestId}, true),
        set_config('openbooks.connector_replay_actor', ${correction.actorId}, true)
    `);
    const authorization = (await tx.execute<{ allowed: boolean }>(sql`
      select connector_historical_replay_authorized(${doc.orgId}) as allowed
    `));
    if (authorization.rows[0]?.allowed !== true) {
      throw new PostingError(
        "closed-period connector replay is not authorized by the active sync run and connection policy",
      );
    }
    authenticatedHistoricalReplay = true;
  }

  const module = closeModuleForDocument(doc.kind);
  if (!authenticatedHistoricalReplay) {
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: entry.periodId,
      bookId: entry.bookId,
      subsidiaryIds: existing.map((line) => line.subsidiaryId),
      modules: [module],
      allowImportedLocks: true,
    });
    await assertPeriodModulesOpen(tx, {
      orgId: doc.orgId,
      periodId: period.id,
      bookId: entry.bookId,
      subsidiaryIds: kernelLines.map((line) => line.subsidiaryId),
      modules: [module],
      allowImportedLocks: true,
    });
  }

  const evidence = {
    mode: "append_only_source_correction",
    reason,
    requestId: correction.requestId,
    documentId: doc.id,
    originalEntryId: entry.id,
    before: {
      postingDate: entry.postingDate,
      periodId: entry.periodId,
    },
    after: {
      postingDate,
      periodId: period.id,
    },
    historicalReplay: authenticatedHistoricalReplay
      ? {
          mode: "authenticated_connector_historical_replay",
          periodLocksPreserved: true,
        }
      : null,
  };
  const [reversal] = await tx
    .insert(schema.journalEntries)
    .values({
      orgId: doc.orgId,
      bookId: entry.bookId,
      subsidiaryId: entry.subsidiaryId,
      entryNumber: `${entry.entryNumber}-SOURCE-REV`,
      postingDate: entry.postingDate,
      periodId: entry.periodId,
      memo: `Source correction reversal: ${reason}`,
      status: "draft",
      sourceDocumentId: doc.id,
      origin: "migration",
      reversesEntryId: entry.id,
      custom: evidence,
      createdBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .returning({ id: schema.journalEntries.id });
  await tx.insert(schema.journalLines).values(
    existing.map((line) => ({
      orgId: doc.orgId,
      entryId: reversal.id,
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      amount: neg(line.amount),
      currency: line.currency,
      txnAmount: neg(line.txnAmount),
      fxRate: line.fxRate,
      partyId: line.partyId,
      departmentId: line.departmentId,
      projectId: line.projectId,
      locationId: line.locationId,
      classId: line.classId,
      equipmentUnitId: line.equipmentUnitId,
      extraDims: line.extraDims,
      paymentCardId: line.paymentCardId,
      taxCodeId: line.taxCodeId,
      memo: line.memo,
      quantity: line.quantity == null ? null : neg(line.quantity),
      unit: line.unit,
      dueDate: null,
      isOpenItem: false,
      custom: line.custom,
    })),
  );
  await tx
    .update(schema.journalEntries)
    .set({
      status: "posted",
      postedAt: new Date(),
      postedBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .where(and(eq(schema.journalEntries.id, reversal.id), eq(schema.journalEntries.orgId, doc.orgId)));
  await tx
    .update(schema.journalEntries)
    .set({
      status: "reversed",
      updatedAt: new Date(),
      updatedBy: correction.actorId,
    })
    .where(and(eq(schema.journalEntries.id, entry.id), eq(schema.journalEntries.orgId, doc.orgId)));

  const [replacement] = await tx
    .insert(schema.journalEntries)
    .values({
      orgId: doc.orgId,
      bookId: entry.bookId,
      subsidiaryId: subApplied.docSubId,
      entryNumber: `${doc.documentNumber}-SOURCE-CORR`,
      postingDate,
      periodId: period.id,
      memo: doc.memo,
      status: "draft",
      sourceDocumentId: doc.id,
      origin: subApplied.multi ? "intercompany" : "migration",
      custom: {
        ...evidence,
        reversalEntryId: reversal.id,
      },
      createdBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .returning({ id: schema.journalEntries.id });
  const replacementLines = await tx
    .insert(schema.journalLines)
    .values(kernelLines.map((line, index) => ({
      orgId: doc.orgId,
      entryId: replacement.id,
      lineNumber: index + 1,
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      amount: line.amount,
      currency: line.currency,
      txnAmount: line.txnAmount,
      fxRate: line.fxRate,
      partyId: line.partyId ?? null,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      equipmentUnitId: line.equipmentUnitId ?? null,
      extraDims: line.extraDims ?? {},
      paymentCardId: line.paymentCardId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      memo: line.memo ?? null,
      dueDate: line.dueDate ?? null,
      isOpenItem: line.isOpenItem ?? false,
    })))
    .returning();
  await tx
    .update(schema.journalEntries)
    .set({
      status: "posted",
      postedAt: new Date(),
      postedBy: correction.actorId,
      updatedBy: correction.actorId,
    })
    .where(and(eq(schema.journalEntries.id, replacement.id), eq(schema.journalEntries.orgId, doc.orgId)));
  const updated = await tx
    .update(schema.documents)
    .set({
      postedEntryId: replacement.id,
      updatedAt: new Date(),
      updatedBy: correction.actorId,
    })
    .where(
      and(
        eq(schema.documents.id, doc.id),
        eq(schema.documents.orgId, doc.orgId),
        eq(schema.documents.postedEntryId, entry.id),
        eq(schema.documents.status, "posted"),
      ),
    )
    .returning({ id: schema.documents.id });
  if (updated.length !== 1) {
    throw new PostingError(
      "the imported document changed while its source correction was being posted",
    );
  }
  const priorLineIds = new Set(existing.map((line) => line.id));
  const transferredApplications: Array<{
    priorApplicationId: string;
    replacementApplicationId: string;
    priorFromLineId: string;
    replacementFromLineId: string;
    priorToLineId: string;
    replacementToLineId: string;
  }> = [];
  const replacementEndpoint = (lineId: string): string => {
    if (!priorLineIds.has(lineId)) return lineId;
    const prior = existing.find((line) => line.id === lineId)!;
    const exact = replacementLines.filter(
      (line) =>
        line.isOpenItem &&
        line.accountId === prior.accountId &&
        line.partyId === prior.partyId &&
        line.subsidiaryId === prior.subsidiaryId &&
        line.currency === prior.currency,
    );
    const candidates = exact.length
      ? exact
      : replacementLines.filter(
          (line) =>
            line.isOpenItem &&
            line.partyId === prior.partyId &&
            line.subsidiaryId === prior.subsidiaryId &&
            line.currency === prior.currency,
        );
    if (candidates.length !== 1) {
      throw new PostingError(
        `cannot transfer application endpoint ${lineId}: expected one replacement open-item line, found ${candidates.length}`,
      );
    }
    return candidates[0]!.id;
  };
  const correctedAt = new Date();
  for (const application of activeApplications) {
    const fromLineId = replacementEndpoint(application.fromLineId);
    const toLineId = replacementEndpoint(application.toLineId);
    const released = await tx
      .update(schema.applications)
      .set({
        unappliedAt: correctedAt,
        updatedAt: correctedAt,
        updatedBy: correction.actorId,
      })
      .where(
        and(
          eq(schema.applications.id, application.id),
          sql`${schema.applications.unappliedAt} is null`,
        ),
      )
      .returning({ id: schema.applications.id });
    if (released.length !== 1) {
      throw new PostingError(
        `application ${application.id} changed during source correction`,
      );
    }
    const [replacementApplication] = await tx
      .insert(schema.applications)
      .values({
        orgId: application.orgId,
        fromLineId,
        toLineId,
        amount: application.amount,
        sourceAmount: application.sourceAmount,
        sourceTransactionAmount: application.sourceTransactionAmount,
        sourceTransactionCurrency: application.sourceTransactionCurrency,
        targetTransactionAmount: application.targetTransactionAmount,
        targetTransactionCurrency: application.targetTransactionCurrency,
        settlementRate: application.settlementRate,
        settlementRateSource: application.settlementRateSource,
        settlementRateReference: application.settlementRateReference,
        settlementFxRateId: application.settlementFxRateId,
        appliedOn: application.appliedOn,
        fxGainLossEntryId: application.fxGainLossEntryId,
        createdBy: correction.actorId,
        updatedBy: correction.actorId,
      })
      .returning({ id: schema.applications.id });
    transferredApplications.push({
      priorApplicationId: application.id,
      replacementApplicationId: replacementApplication.id,
      priorFromLineId: application.fromLineId,
      replacementFromLineId: fromLineId,
      priorToLineId: application.toLineId,
      replacementToLineId: toLineId,
    });
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (
          ${doc.orgId}, 'applications', ${application.id}, 'update',
          ${JSON.stringify({
            mode: "append_only_source_correction",
            reason,
            replacementApplicationId: replacementApplication.id,
            before: { unappliedAt: null },
            after: { unappliedAt: correctedAt.toISOString() },
          })}::jsonb,
          ${correction.actorId}, ${correction.requestId}
        ),
        (
          ${doc.orgId}, 'applications', ${replacementApplication.id}, 'insert',
          ${JSON.stringify({
            mode: "append_only_source_correction",
            reason,
            priorApplicationId: application.id,
            fromLineId,
            toLineId,
          })}::jsonb,
          ${correction.actorId}, ${correction.requestId}
        )
    `);
  }
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${doc.orgId}, 'documents', ${doc.id}, 'update',
      ${JSON.stringify({
        ...evidence,
        reversalEntryId: reversal.id,
        replacementEntryId: replacement.id,
        dependencyChecks: {
          bankReconciliation: false,
          transferredApplications,
          inventoryMovements: false,
          revenueRecognition: false,
          downstreamDocuments: false,
        },
      })}::jsonb,
      ${correction.actorId}, ${correction.requestId}
    )
  `);
  if (authenticatedHistoricalReplay) {
    await tx.execute(sql`
      select
        set_config('openbooks.connector_replay', 'off', true),
        set_config('openbooks.connector_replay_request', '', true),
        set_config('openbooks.connector_replay_actor', '', true)
    `);
  }
  return { entryId: replacement.id, changed: true };
}
