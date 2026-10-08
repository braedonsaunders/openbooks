/**
 * Internal billing accounting policy and its GL projection. Pure: the save
 * service and the posting rule apply exactly these checks, so a document
 * that saves under a rule posts under it, and a document edited through any
 * other path still meets the policy at the ledger boundary.
 *
 * An internal billing document moves value from a PROVIDER (the header
 * subsidiary, department, project, location and class) to a RECEIVER (each
 * line's own dimensions; a dimension the line leaves empty is the
 * provider's). Each line debits the rule's debit account with the receiver's
 * dimensions and credits the rule's credit account with the provider's.
 *
 * - revenue_credit: both accounts are revenue, in one legal entity. The
 *   company's revenue is unchanged and the providing department is credited
 *   with the sale. Project is never stamped on these legs: a department
 *   credit must not restate a job's customer revenue.
 * - cost_transfer: both accounts are cost, in one legal entity. Company cost
 *   is unchanged; the debit leg carries the receiving project as job cost.
 * - intercompany_sale: the receiver is another subsidiary. The provider
 *   books eliminated revenue, the receiver eliminated cost, and the posting
 *   kernel adds the due-to/due-from legs from the intercompany pair, so
 *   consolidated revenue and cost are unchanged.
 */
import { cmp } from "../money/money.ts";
import { negMoney, parseMoney } from "../money/brands.ts";
import type {
  Doc,
  DocLine,
  InternalBillingAccountFacts,
  InternalBillingPostingContext,
  InternalBillingRuleFacts,
  KernelLine,
} from "../journal/posting-contracts.ts";

export type InternalBillingMethod = InternalBillingRuleFacts["method"];

/** Revenue account types an internal billing rule may name. */
export const INTERNAL_BILLING_INCOME_TYPES: readonly string[] = ["income", "income_other"];
/** Cost account types an internal billing rule may name. */
export const INTERNAL_BILLING_COST_TYPES: readonly string[] = ["cogs", "expense", "expense_other"];

/** A refusal of the internal billing policy, phrased for the operator. */
export class InternalBillingPolicyError extends Error {
  override readonly name = "InternalBillingPolicyError";
}

/** Account types each side of a rule accepts, by method. */
export function internalBillingAccountTypes(method: InternalBillingMethod): {
  debit: readonly string[];
  credit: readonly string[];
} {
  switch (method) {
    case "revenue_credit":
      return { debit: INTERNAL_BILLING_INCOME_TYPES, credit: INTERNAL_BILLING_INCOME_TYPES };
    case "cost_transfer":
      return { debit: INTERNAL_BILLING_COST_TYPES, credit: INTERNAL_BILLING_COST_TYPES };
    case "intercompany_sale":
      return { debit: INTERNAL_BILLING_COST_TYPES, credit: INTERNAL_BILLING_INCOME_TYPES };
  }
}

/** Whether lines under this method may be billed on to a customer. */
export function internalBillingAllowsBillable(method: InternalBillingMethod): boolean {
  return method !== "revenue_credit";
}

const TYPE_WORDS: Record<string, string> = {
  income: "an income",
  income_other: "an other-income",
  cogs: "a cost of goods sold",
  expense: "an expense",
  expense_other: "an other-expense",
};

function typeList(types: readonly string[]): string {
  return types.map((type) => TYPE_WORDS[type] ?? type).join(" or ") + " account";
}

/** Refuse account choices that would not keep the movement out of company totals. */
export function assertInternalBillingRuleAccounts(
  method: InternalBillingMethod,
  debit: InternalBillingAccountFacts,
  credit: InternalBillingAccountFacts,
): void {
  if (debit.id === credit.id) {
    throw new InternalBillingPolicyError(
      "the receiving and providing accounts must be different; choose two accounts on the rule",
    );
  }
  const allowed = internalBillingAccountTypes(method);
  for (const [side, account, types] of [
    ["receiving (debit)", debit, allowed.debit],
    ["providing (credit)", credit, allowed.credit],
  ] as const) {
    if (!account.isActive || account.isSummary) {
      throw new InternalBillingPolicyError(
        `${account.label} is ${account.isSummary ? "a summary account" : "inactive"}; choose an active posting account for the ${side} side`,
      );
    }
    if (!types.includes(account.type)) {
      throw new InternalBillingPolicyError(
        `${account.label} cannot be the ${side} account of a ${methodLabel(method)} rule; choose ${typeList(types)}`,
      );
    }
    if (method === "intercompany_sale" && !account.eliminate) {
      throw new InternalBillingPolicyError(
        `${account.label} is not eliminated in consolidation; mark the account Eliminate on consolidation in Chart of accounts`,
      );
    }
  }
}

export function methodLabel(method: InternalBillingMethod): string {
  switch (method) {
    case "revenue_credit":
      return "department credit";
    case "cost_transfer":
      return "cost transfer";
    case "intercompany_sale":
      return "intercompany sale";
  }
}

/** Whether a rule version governs documents dated `date` (ISO yyyy-mm-dd). */
export function internalBillingRuleInEffect(
  rule: Pick<InternalBillingRuleFacts, "effectiveFrom" | "effectiveTo" | "isActive">,
  date: string,
): boolean {
  return rule.isActive && rule.effectiveFrom <= date && (rule.effectiveTo == null || date <= rule.effectiveTo);
}

export interface InternalBillingParty {
  subsidiaryId: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
}

type HeaderDims = Pick<Doc, "departmentId" | "projectId" | "locationId" | "classId">;
type LineDims = Pick<DocLine, "subsidiaryId" | "departmentId" | "projectId" | "locationId" | "classId">;

/** The providing side: the document header. */
export function internalBillingProvider(header: HeaderDims, providerSubsidiaryId: string): InternalBillingParty {
  return {
    subsidiaryId: providerSubsidiaryId,
    departmentId: header.departmentId ?? null,
    projectId: header.projectId ?? null,
    locationId: header.locationId ?? null,
    classId: header.classId ?? null,
  };
}

/** The receiving side of one line: its own dimensions over the provider's. */
export function internalBillingReceiver(provider: InternalBillingParty, line: LineDims): InternalBillingParty {
  return {
    subsidiaryId: line.subsidiaryId ?? provider.subsidiaryId,
    departmentId: line.departmentId ?? provider.departmentId,
    projectId: line.projectId ?? provider.projectId,
    locationId: line.locationId ?? provider.locationId,
    classId: line.classId ?? provider.classId,
  };
}

/**
 * Refuse a line the method cannot post. `lineNumber` names the line in the
 * refusal. Billable means the receiving project's customer is billed for it.
 */
export function assertInternalBillingLine(args: {
  method: InternalBillingMethod;
  provider: InternalBillingParty;
  receiver: InternalBillingParty;
  /** The receiving project entered on the line itself. */
  lineProjectId: string | null;
  isBillable: boolean;
  multiSubsidiary: boolean;
  lineNumber: number;
}): void {
  const { method, provider, receiver, lineNumber } = args;
  const at = `line ${lineNumber}`;
  if (method === "intercompany_sale") {
    if (!args.multiSubsidiary) {
      throw new InternalBillingPolicyError(
        `${at}: an intercompany sale needs Multi-subsidiary; turn it on in Company Settings → Features`,
      );
    }
    if (receiver.subsidiaryId === provider.subsidiaryId) {
      throw new InternalBillingPolicyError(
        `${at}: an intercompany sale must bill a different subsidiary; choose the receiving subsidiary on the line`,
      );
    }
  } else if (receiver.subsidiaryId !== provider.subsidiaryId) {
    throw new InternalBillingPolicyError(
      `${at}: a ${methodLabel(method)} stays within one subsidiary; use an intercompany sale rule to bill another subsidiary`,
    );
  }
  if (method === "revenue_credit") {
    if (args.isBillable) {
      throw new InternalBillingPolicyError(
        `${at}: a department credit is not billable to a customer; clear Billable or use a cost transfer rule`,
      );
    }
    const moves =
      receiver.departmentId !== provider.departmentId ||
      receiver.locationId !== provider.locationId ||
      receiver.classId !== provider.classId;
    if (!moves) {
      throw new InternalBillingPolicyError(
        `${at}: the receiver is the same department, location and class as the provider; choose who receives the work`,
      );
    }
  } else if (method === "cost_transfer") {
    const moves =
      receiver.departmentId !== provider.departmentId ||
      receiver.projectId !== provider.projectId ||
      receiver.locationId !== provider.locationId ||
      receiver.classId !== provider.classId;
    if (!moves) {
      throw new InternalBillingPolicyError(
        `${at}: the receiver is the same department, project, location and class as the provider; choose who receives the cost`,
      );
    }
  }
  if (args.isBillable && !args.lineProjectId) {
    throw new InternalBillingPolicyError(
      `${at}: a billable line needs the receiving project whose customer is billed; choose a project on the line`,
    );
  }
}

/**
 * Build the kernel lines for an internal billing document and refuse
 * anything the policy does not allow. Every check is repeated here so a
 * document changed after it was saved cannot post outside its rule.
 */
export function internalBillingKernelLines(
  doc: Doc,
  lines: DocLine[],
  context: InternalBillingPostingContext | undefined,
): KernelLine[] {
  if (!context) {
    throw new InternalBillingPolicyError("internal billing posting context was not resolved");
  }
  const { rule } = context;
  if (doc.internalBillingRuleId !== rule.id) {
    throw new InternalBillingPolicyError(
      "the document's internal billing rule changed; open the document and save it again",
    );
  }
  const date = String(doc.documentDate).slice(0, 10);
  if (!internalBillingRuleInEffect(rule, date)) {
    throw new InternalBillingPolicyError(
      `internal billing rule ${rule.code} is not in effect on ${date}; open the document and save it again to apply the rule version in effect, or add a version in Setup → Internal billing`,
    );
  }
  assertInternalBillingRuleAccounts(rule.method, context.debitAccount, context.creditAccount);
  const provider = internalBillingProvider(doc, context.providerSubsidiaryId);
  const headerExtra = (doc.extraDims ?? {}) as Record<string, string | null>;
  const out: KernelLine[] = [];
  for (const line of lines) {
    if (line.accountId !== rule.debitAccountId || line.recoveryAccountId !== rule.creditAccountId) {
      throw new InternalBillingPolicyError(
        `line ${line.lineNumber} does not carry the accounts of rule ${rule.code}; open the document and save it again`,
      );
    }
    const amount = parseMoney(line.amount);
    if (cmp(amount, "0") <= 0) {
      throw new InternalBillingPolicyError(`line ${line.lineNumber}: the amount must be greater than zero`);
    }
    const receiver = internalBillingReceiver(provider, line);
    assertInternalBillingLine({
      method: rule.method,
      provider,
      receiver,
      lineProjectId: line.projectId ?? null,
      isBillable: Boolean(line.isBillable),
      multiSubsidiary: context.multiSubsidiary,
      lineNumber: line.lineNumber,
    });
    const stampsProject = rule.method !== "revenue_credit";
    out.push({
      accountId: rule.debitAccountId,
      amount,
      memo: line.description,
      // Only an intercompany sale lands in another entity; the kernel adds
      // the due-to/due-from legs that keep each subsidiary balanced.
      ...(receiver.subsidiaryId !== provider.subsidiaryId ? { subsidiaryId: receiver.subsidiaryId } : {}),
      departmentId: receiver.departmentId,
      projectId: stampsProject ? receiver.projectId : null,
      locationId: receiver.locationId,
      classId: receiver.classId,
      equipmentUnitId: null,
      extraDims: { ...headerExtra, ...((line.extraDims ?? {}) as Record<string, string | null>) },
    });
    out.push({
      accountId: rule.creditAccountId,
      amount: negMoney(amount),
      memo: line.description,
      departmentId: provider.departmentId,
      projectId: stampsProject ? provider.projectId : null,
      locationId: provider.locationId,
      classId: provider.classId,
      equipmentUnitId: null,
      extraDims: headerExtra,
    });
  }
  return out;
}

