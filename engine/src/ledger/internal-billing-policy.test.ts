import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "../money/money.ts";
import type {
  InternalBillingAccountFacts,
  InternalBillingPostingContext,
  PostingDocument,
  PostingDocumentLine,
} from "../journal/posting-contracts.ts";
import { internalBillingKernelLines, InternalBillingPolicyError } from "./internal-billing-policy.ts";

const SUB_A = "00000000-0000-4000-8000-00000000000a";
const SUB_B = "00000000-0000-4000-8000-00000000000b";
const SHOP = "00000000-0000-4000-8000-000000000d01";
const FIELD = "00000000-0000-4000-8000-000000000d02";
const JOB = "00000000-0000-4000-8000-000000000f01";
const PROVIDER_JOB = "00000000-0000-4000-8000-000000000f02";
const RULE = "00000000-0000-4000-8000-0000000000e1";

const account = (id: string, type: string, extra: Partial<InternalBillingAccountFacts> = {}): InternalBillingAccountFacts => ({
  id, label: `${type} ${id.slice(-2)}`, type, eliminate: false, isActive: true, isSummary: false, ...extra,
});

const SALES_RECEIVER = account("00000000-0000-4000-8000-0000000000a1", "income");
const SALES_PROVIDER = account("00000000-0000-4000-8000-0000000000a2", "income");
const COST_RECEIVER = account("00000000-0000-4000-8000-0000000000a3", "cogs");
const COST_PROVIDER = account("00000000-0000-4000-8000-0000000000a4", "expense");
const IC_COST = account("00000000-0000-4000-8000-0000000000a5", "cogs", { eliminate: true });
const IC_SALES = account("00000000-0000-4000-8000-0000000000a6", "income", { eliminate: true });

function context(
  method: InternalBillingPostingContext["rule"]["method"],
  debit: InternalBillingAccountFacts,
  credit: InternalBillingAccountFacts,
  overrides: Partial<InternalBillingPostingContext> = {},
): InternalBillingPostingContext {
  return {
    rule: {
      id: RULE, code: "SHOP", name: "Shop work", method,
      debitAccountId: debit.id, creditAccountId: credit.id,
      effectiveFrom: "2026-01-01", effectiveTo: null, isActive: true,
    },
    debitAccount: debit,
    creditAccount: credit,
    providerSubsidiaryId: SUB_A,
    multiSubsidiary: true,
    ...overrides,
  };
}

const doc = (overrides: Partial<PostingDocument> = {}) => ({
  internalBillingRuleId: RULE,
  documentDate: "2026-03-15",
  subsidiaryId: SUB_A,
  departmentId: SHOP,
  projectId: null,
  locationId: null,
  classId: null,
  extraDims: {},
  ...overrides,
}) as unknown as PostingDocument;

const line = (ctx: InternalBillingPostingContext, overrides: Partial<PostingDocumentLine> = {}) => ({
  lineNumber: 1,
  accountId: ctx.rule.debitAccountId,
  recoveryAccountId: ctx.rule.creditAccountId,
  amount: "1200.0000",
  description: "Fabrication",
  subsidiaryId: null,
  departmentId: FIELD,
  projectId: null,
  locationId: null,
  classId: null,
  isBillable: false,
  extraDims: {},
  ...overrides,
}) as unknown as PostingDocumentLine;

const summary = (lines: ReturnType<typeof internalBillingKernelLines>) =>
  lines.map((l) => ({ account: l.accountId, amount: l.amount, sub: l.subsidiaryId ?? null, dept: l.departmentId, project: l.projectId }));

test("a department credit moves revenue between departments and never touches company revenue or the job", () => {
  const ctx = context("revenue_credit", SALES_RECEIVER, SALES_PROVIDER);
  const legs = internalBillingKernelLines(doc({ projectId: PROVIDER_JOB }), [line(ctx, { projectId: JOB })], ctx);
  assert.deepEqual(summary(legs), [
    { account: SALES_RECEIVER.id, amount: "1200.0000", sub: null, dept: FIELD, project: null },
    { account: SALES_PROVIDER.id, amount: "-1200.0000", sub: null, dept: SHOP, project: null },
  ]);
  // Both legs are revenue: the company total moves by exactly zero.
  assert.equal(sum(legs.map((l) => l.amount)), "0.0000");
});

test("a cost transfer charges the receiving project and relieves the provider's own dimensions", () => {
  const ctx = context("cost_transfer", COST_RECEIVER, COST_PROVIDER);
  const legs = internalBillingKernelLines(
    doc({ projectId: PROVIDER_JOB }),
    [line(ctx, { projectId: JOB, isBillable: true, departmentId: null })],
    ctx,
  );
  assert.deepEqual(summary(legs), [
    { account: COST_RECEIVER.id, amount: "1200.0000", sub: null, dept: SHOP, project: JOB },
    { account: COST_PROVIDER.id, amount: "-1200.0000", sub: null, dept: SHOP, project: PROVIDER_JOB },
  ]);
  assert.equal(sum(legs.map((l) => l.amount)), "0.0000");
});

test("an intercompany sale lands its debit in the receiving subsidiary", () => {
  const ctx = context("intercompany_sale", IC_COST, IC_SALES);
  const legs = internalBillingKernelLines(doc(), [line(ctx, { subsidiaryId: SUB_B, projectId: JOB })], ctx);
  assert.deepEqual(summary(legs), [
    { account: IC_COST.id, amount: "1200.0000", sub: SUB_B, dept: FIELD, project: JOB },
    { account: IC_SALES.id, amount: "-1200.0000", sub: null, dept: SHOP, project: null },
  ]);
});

test("account types must fit the method, and intercompany accounts must be eliminated", () => {
  const wrongType = context("revenue_credit", COST_RECEIVER, SALES_PROVIDER);
  assert.throws(() => internalBillingKernelLines(doc(), [line(wrongType)], wrongType), /cannot be the receiving \(debit\) account of a department credit rule/);
  const costIntoRevenue = context("cost_transfer", COST_RECEIVER, SALES_PROVIDER);
  assert.throws(() => internalBillingKernelLines(doc(), [line(costIntoRevenue)], costIntoRevenue), /providing \(credit\) account of a cost transfer rule/);
  const notEliminated = context("intercompany_sale", IC_COST, SALES_PROVIDER);
  assert.throws(
    () => internalBillingKernelLines(doc(), [line(notEliminated, { subsidiaryId: SUB_B })], notEliminated),
    /mark the account Eliminate on consolidation in Chart of accounts/,
  );
});

test("an intercompany sale needs another subsidiary and Multi-subsidiary", () => {
  const ctx = context("intercompany_sale", IC_COST, IC_SALES);
  assert.throws(() => internalBillingKernelLines(doc(), [line(ctx, { subsidiaryId: SUB_A })], ctx), /must bill a different subsidiary/);
  const off = context("intercompany_sale", IC_COST, IC_SALES, { multiSubsidiary: false });
  assert.throws(() => internalBillingKernelLines(doc(), [line(off, { subsidiaryId: SUB_B })], off), /needs Multi-subsidiary/);
  const sameEntity = context("cost_transfer", COST_RECEIVER, COST_PROVIDER);
  assert.throws(() => internalBillingKernelLines(doc(), [line(sameEntity, { subsidiaryId: SUB_B })], sameEntity), /use an intercompany sale rule/);
});

test("a department credit refuses billable lines and a transfer that moves nothing", () => {
  const ctx = context("revenue_credit", SALES_RECEIVER, SALES_PROVIDER);
  assert.throws(() => internalBillingKernelLines(doc(), [line(ctx, { isBillable: true, projectId: JOB })], ctx), /not billable to a customer/);
  // Only the project differs, and project is not stamped on revenue legs.
  assert.throws(() => internalBillingKernelLines(doc(), [line(ctx, { departmentId: SHOP, projectId: JOB })], ctx), /same department, location and class/);
  const transfer = context("cost_transfer", COST_RECEIVER, COST_PROVIDER);
  assert.throws(() => internalBillingKernelLines(doc(), [line(transfer, { departmentId: null, isBillable: true })], transfer), /same department, project/);
  assert.throws(() => internalBillingKernelLines(doc(), [line(transfer, { isBillable: true })], transfer), /billable line needs the receiving project/);
});

test("posting refuses a rule out of effect and lines that do not carry the rule's accounts", () => {
  const ctx = context("revenue_credit", SALES_RECEIVER, SALES_PROVIDER);
  assert.throws(() => internalBillingKernelLines(doc({ documentDate: "2025-12-31" }), [line(ctx)], ctx), /not in effect on 2025-12-31/);
  const closed = context("revenue_credit", SALES_RECEIVER, SALES_PROVIDER, {
    rule: { ...ctx.rule, effectiveTo: "2026-02-28" },
  });
  assert.throws(() => internalBillingKernelLines(doc(), [line(closed)], closed), /not in effect/);
  assert.throws(
    () => internalBillingKernelLines(doc(), [line(ctx, { recoveryAccountId: COST_PROVIDER.id })], ctx),
    /does not carry the accounts of rule SHOP/,
  );
  assert.throws(() => internalBillingKernelLines(doc(), [line(ctx, { amount: "-5.0000" })], ctx), /greater than zero/);
  assert.throws(() => internalBillingKernelLines(doc(), [line(ctx)], undefined), InternalBillingPolicyError);
});
