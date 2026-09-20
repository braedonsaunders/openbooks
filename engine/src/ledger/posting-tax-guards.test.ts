import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAccountCurrencyRestrictions,
  assertCreditMemoDirection,
  defaultPartyAddress,
  PostingError,
  providerTaxDocumentKind,
  taxConfigsFromEvidence,
  validateRequiredDimensions,
  validateTaxControlAccounts,
  type KernelLine,
  type PostingDeps,
  type PostingDocument,
  type PostingDocumentLine,
  type TaxPostingComponent,
} from "./posting.ts";
import type { db } from "../platform/db.ts";

type Runner = Pick<typeof db, "execute">;

const stubRunner = (rows: unknown[], onQuery?: () => void): Runner =>
  ({
    execute: async () => {
      onQuery?.();
      return { rows };
    },
  }) as unknown as Runner;

const component = (over: Partial<TaxPostingComponent> = {}): TaxPostingComponent => ({
  taxCodeId: "GST",
  sequence: 1,
  taxAmount: "13.0000",
  recoverableAmount: "13.0000",
  nonrecoverableAmount: "0.0000",
  calculationType: "standard",
  collectedAccountId: null,
  paidAccountId: null,
  withholdingAccountId: null,
  ...over,
});

const docLine = (over: Record<string, unknown> = {}): PostingDocumentLine =>
  ({
    id: "line-1",
    lineNumber: 1,
    taxCodeId: "GST",
    taxGroupId: null,
    taxAmount: "13.0000",
    ...over,
  }) as unknown as PostingDocumentLine;

const doc = (kind: string): PostingDocument =>
  ({ kind }) as unknown as PostingDocument;

const deps = (over: Partial<PostingDeps> = {}): PostingDeps =>
  ({
    control: { ar: "ar", ap: "ap", bank: "bank" },
    ...over,
  }) as PostingDeps;

const withComponents = (...cs: TaxPostingComponent[]): PostingDeps =>
  deps({ taxComponentsByLine: new Map([["line-1", cs]]) });

test("tax components that do not cross-foot to the stored line total are refused", () => {
  assert.throws(
    () =>
      validateTaxControlAccounts(doc("customer_invoice"), [docLine({ taxAmount: "12.0000" })], withComponents(component())),
    (e: unknown) => e instanceof PostingError && /do not match stored tax total/.test(e.message),
  );
});

test("a tax amount without calculation evidence is refused", () => {
  assert.throws(
    () =>
      validateTaxControlAccounts(
        doc("customer_invoice"),
        [docLine({ taxCodeId: null, taxGroupId: null, taxAmount: "5.0000" })],
        deps(),
      ),
    (e: unknown) => e instanceof PostingError && /no calculation evidence/.test(e.message),
  );
});

test("documents outside purchase/sales skip tax control-account validation", () => {
  // A journal carrying a withholding component with no withholding account
  // must pass silently: the control-account matrix only governs purchase and
  // sales documents. Negating the early return makes this throw.
  const c = component({ taxAmount: "5.0000", calculationType: "withholding" });
  const l = docLine({ taxCodeId: "WHT", taxAmount: "-5.0000" });
  assert.deepEqual(validateTaxControlAccounts(doc("journal"), [l], withComponents(c)), undefined);
});

test("withholding without a withholding account fails closed on purchase documents", () => {
  const c = component({ taxAmount: "5.0000", recoverableAmount: "0.0000", calculationType: "withholding" });
  assert.throws(
    () => validateTaxControlAccounts(doc("vendor_bill"), [docLine({ taxAmount: "-5.0000" })], withComponents(c)),
    (e: unknown) => e instanceof PostingError && /no withholding account/.test(e.message),
  );
});

test("sales lines demand the collected account, never the paid account", () => {
  // Paid is configured but collected is not: a sales line must still refuse.
  // Routing sales through the purchase branch would accept the paid account.
  const d = deps({
    control: { ar: "ar", ap: "ap", bank: "bank", taxPaid: "tax-paid" },
    taxComponentsByLine: new Map([["line-1", [component()]]]),
  });
  assert.throws(
    () => validateTaxControlAccounts(doc("customer_invoice"), [docLine()], d),
    (e: unknown) => e instanceof PostingError && /no configured tax control account/.test(e.message),
  );
});

test("reverse-charge sales lines need no collected account", () => {
  // Reverse charge does not change settlement: the stored line total is zero
  // while the self-assessed component stays nonzero and must still be seen.
  const c = component({ calculationType: "reverse_charge" });
  assert.deepEqual(
    validateTaxControlAccounts(doc("customer_invoice"), [docLine({ taxAmount: "0.0000" })], withComponents(c)),
    undefined,
  );
});

test("fully nonrecoverable purchase tax needs no paid account", () => {
  const c = component({ recoverableAmount: "0.0000", nonrecoverableAmount: "13.0000" });
  assert.deepEqual(
    validateTaxControlAccounts(doc("vendor_bill"), [docLine()], withComponents(c)),
    undefined,
  );
});

test("provider-tax document kinds are exactly the four taxable commercial documents", () => {
  for (const kind of ["customer_invoice", "customer_credit", "vendor_bill", "vendor_credit"]) {
    assert.equal(providerTaxDocumentKind(kind), true, kind);
  }
  for (const kind of ["journal", "payment", "expense_report", "check", "deposit", ""]) {
    assert.equal(providerTaxDocumentKind(kind), false, kind);
  }
});

test("a null party needs no address lookup", async () => {
  assert.deepEqual(await defaultPartyAddress("org-1", null, false), {});
});

test("a currency-restricted account refuses any other line currency", async () => {
  const runner = stubRunner([{ id: "acct-1", number: "1000", name: "USD bank", restriction: "USD" }]);
  await assert.rejects(
    () => assertAccountCurrencyRestrictions(runner, "org-1", [{ accountId: "acct-1", currency: "EUR" }]),
    (e: unknown) => e instanceof PostingError && /only accepts USD postings/.test(e.message),
  );
  await assertAccountCurrencyRestrictions(runner, "org-1", [{ accountId: "acct-1", currency: "USD" }]);
  const open = stubRunner([{ id: "acct-1", number: "1000", name: "Operating", restriction: null }]);
  await assertAccountCurrencyRestrictions(open, "org-1", [{ accountId: "acct-1", currency: "EUR" }]);
});

test("currency-restriction checks issue no query for an empty line set", async () => {
  let queried = false;
  const runner = stubRunner([], () => {
    queried = true;
    throw new Error("must not query for empty lines");
  });
  await assertAccountCurrencyRestrictions(runner, "org-1", []);
  assert.equal(queried, false);
});

test("a negative-total credit memo is refused; migrations and invoices are unaffected", () => {
  const customer = (total: string) => ({ kind: "customer_credit", total });
  const vendor = (total: string) => ({ kind: "vendor_credit", total });
  assert.throws(() => assertCreditMemoDirection(customer("-1.0000")), /negative balance owed by the customer is an invoice/);
  assert.throws(() => assertCreditMemoDirection(vendor("-1.0000")), /negative balance owed to the vendor is a bill/);
  // Exact boundary: even one unit below zero (a tenth of a cent) is backwards.
  assert.throws(() => assertCreditMemoDirection(customer("-0.0001")), /negative balance owed by the customer/);
  assert.throws(() => assertCreditMemoDirection(vendor("-0.0001")), /negative balance owed to the vendor/);
  assertCreditMemoDirection(customer("1.0000"));
  assertCreditMemoDirection(vendor("1.0000"));
  assertCreditMemoDirection(customer("-1.0000"), true);
  assertCreditMemoDirection({ kind: "customer_invoice", total: "-1.0000" });
});

test("evidence without a recovery ratio reconstructs it exactly; zero tax recovers fully", () => {
  const partial = taxConfigsFromEvidence([
    component({ ratePercent: "13", taxAmount: "13.0000", recoverableAmount: "6.5000" }),
  ]);
  assert.equal(partial[0]!.recoverablePercent, "50.0000");
  const zeroed = taxConfigsFromEvidence([component({ taxAmount: "0.0000", recoverableAmount: "0.0000" })]);
  assert.equal(zeroed[0]!.recoverablePercent, "100");
  const explicit = taxConfigsFromEvidence([component({ recoverablePercent: "25" })]);
  assert.equal(explicit[0]!.recoverablePercent, "25");
});

test("a line missing a required dimension names the segment; present dimensions pass", async () => {
  const rows = [
    {
      id: "acct-1",
      number: "6000",
      name: "Travel",
      required_dimensions: ["department"],
      segment_names: { department: "Department" },
    },
  ];
  const missing: KernelLine[] = [{ accountId: "acct-1", amount: "10.0000" }];
  await assert.rejects(
    () => validateRequiredDimensions(stubRunner(rows), "org-1", missing),
    (e: unknown) => e instanceof PostingError && /Department is required for account 6000/.test(e.message),
  );
  await validateRequiredDimensions(stubRunner(rows), "org-1", [
    { accountId: "acct-1", amount: "10.0000", departmentId: "dept-1" },
  ]);
});

test("the party segment label reads Party in the required-dimension refusal", async () => {
  const rows = [
    { id: "acct-1", number: null, name: "AR", required_dimensions: ["party"], segment_names: {} },
  ];
  await assert.rejects(
    () => validateRequiredDimensions(stubRunner(rows), "org-1", [{ accountId: "acct-1", amount: "10.0000" }]),
    (e: unknown) => e instanceof PostingError && /^Party is required/.test(e.message),
  );
});
