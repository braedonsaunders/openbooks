import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../platform/db.ts";
import {
  PostingError,
  type PostingDeps,
  type PostingDocument,
  type PostingDocumentLine,
  type TaxPostingComponent,
} from "./posting-contracts.ts";
import {
  documentLocationChange,
  resolveProviderTaxPlans,
  taxConfigsFromEvidence,
} from "./posting-provider-tax.ts";

const component = (over: Partial<TaxPostingComponent> = {}): TaxPostingComponent => ({
  taxCodeId: "TAX-ON",
  sequence: 1,
  taxAmount: "13.0000",
  recoverableAmount: "13.0000",
  nonrecoverableAmount: "0.0000",
  calculationType: "standard",
  collectedAccountId: null,
  paidAccountId: null,
  withholdingAccountId: null,
  ratePercent: "13",
  priceIncludesTax: false,
  compoundOnPrevious: false,
  roundingScale: 2,
  ...over,
});

const doc = (over: Record<string, unknown> = {}): PostingDocument =>
  ({
    orgId: "org-1",
    kind: "customer_invoice",
    currency: "USD",
    documentDate: "2026-09-01",
    partyId: "party-1",
    ...over,
  }) as unknown as PostingDocument;

const line = (over: Record<string, unknown> = {}): PostingDocumentLine =>
  ({
    id: "line-1",
    lineNumber: 1,
    amount: "100.0000",
    taxInputAmount: null,
    taxAmount: "13.0000",
    taxCodeId: "TAX-ON",
    taxGroupId: null,
    ...over,
  }) as unknown as PostingDocumentLine;

const deps = (over: Partial<PostingDeps> = {}): PostingDeps =>
  ({
    control: { ar: "1100", ap: "2100", bank: "1000" },
    taxComponentsByLine: new Map([["line-1", [component()]]]),
    ...over,
  }) as PostingDeps;

const configRow = (over: Record<string, unknown> = {}) => ({
  id: "cfg-1",
  orgId: "org-1",
  provider: "avalara",
  displayName: "Avalara",
  isEnabled: true,
  settings: {},
  secrets: null,
  preferProvider: true,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  updatedAt: null,
  ...over,
});

const quoteRow = (over: Record<string, unknown> = {}) => ({
  id: "q-1",
  provider_config_id: "cfg-1",
  provider: "avalara",
  quoted_on: "2026-09-01",
  currency: "USD",
  ship_from: {},
  ship_to: {
    line1: "1 Main St",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    country: "US",
  },
  taxable_amount: "100.0000",
  tax_amount: "13.0000",
  components: [{ jurisdiction: "TX", ratePercent: "13", taxAmount: "13.0000" }],
  external_ref: "ext-1",
  raw_payload: null,
  ...over,
});

/** Mock only the database reads (config, address, quote); money and tax math stay real. */
const evidenceReads = (steps: Record<string, unknown>[][]) => {
  let calls = 0;
  return async () => {
    const step = steps[calls];
    calls += 1;
    if (!step) throw new Error(`unexpected database read #${calls}`);
    return { rows: step };
  };
};

const codeRow = (over: Record<string, unknown> = {}) => ({
  id: "TAX-ON",
  code: "TX",
  calculationType: "standard",
  recoverablePercent: "100",
  roundingScale: 2,
  collectedAccountId: null,
  paidAccountId: null,
  withholdingAccountId: null,
  isActive: true,
  ...over,
});

const mappedConfig = () =>
  configRow({ settings: { jurisdictionTaxCodes: { TX: "TAX-ON" } } });

test("a matching immutable quote resolves to the stored evidence components", async (t) => {
  t.mock.method(db, "execute", evidenceReads([[mappedConfig()], [quoteRow()], [codeRow()]]));
  const plans = await resolveProviderTaxPlans(doc(), [line()], deps());
  assert.equal(plans.length, 1);
  const [plan] = plans;
  assert.ok(plan);
  assert.equal(plan.line.id, "line-1");
  assert.deepEqual(plan.components, [component()]);
});

test("a component bound to the wrong tax code is refused even when amounts match", async (t) => {
  t.mock.method(db, "execute", evidenceReads([[mappedConfig()], [quoteRow()], [codeRow()]]));
  const swapped = deps({ taxComponentsByLine: new Map([["line-1", [component({ taxCodeId: "OTHER" })]]]) });
  await assert.rejects(
    () => resolveProviderTaxPlans(doc(), [line()], swapped),
    (e: unknown) =>
      e instanceof PostingError &&
      /books the wrong tax code for provider jurisdiction "TX" \(mapped to "TX"\)/.test(e.message),
  );
});

test("migrations bypass provider tax without touching evidence", async () => {
  assert.deepEqual(
    await resolveProviderTaxPlans(doc(), [line()], deps({ migration: true })),
    [],
  );
});

test("documents outside the provider-tax kinds bypass without evidence reads", async () => {
  assert.deepEqual(
    await resolveProviderTaxPlans(doc({ kind: "journal" }), [line()], deps()),
    [],
  );
});

test("a line without a tax profile resolves to no plan and reads no quote", async (t) => {
  t.mock.method(db, "execute", evidenceReads([[configRow()]]));
  const untaxed = line({
    id: "line-9",
    lineNumber: 9,
    amount: "50.0000",
    taxAmount: "0.0000",
    taxCodeId: null,
    taxGroupId: null,
  });
  assert.deepEqual(await resolveProviderTaxPlans(doc(), [untaxed], deps()), []);
});

test("a missing immutable quote fails closed before posting", async (t) => {
  t.mock.method(db, "execute", evidenceReads([[configRow()], []]));
  await assert.rejects(
    () => resolveProviderTaxPlans(doc(), [line()], deps()),
    (e: unknown) =>
      e instanceof PostingError && /no immutable tax-provider quote/.test(e.message),
  );
});

test("a quote from another provider config is refused as ambiguous provenance", async (t) => {
  t.mock.method(db, "execute", evidenceReads([
    [configRow()],
    [quoteRow({ provider_config_id: "cfg-2" })],
  ]));
  await assert.rejects(
    () => resolveProviderTaxPlans(doc(), [line()], deps()),
    (e: unknown) =>
      e instanceof PostingError && /ambiguous tax-provider provenance/.test(e.message),
  );
});

test("a stale quote that no longer matches the document is refused", async (t) => {
  t.mock.method(db, "execute", evidenceReads([
    [configRow()],
    [quoteRow({ quoted_on: "2026-08-01" })],
  ]));
  await assert.rejects(
    () => resolveProviderTaxPlans(doc(), [line()], deps()),
    (e: unknown) =>
      e instanceof PostingError && /does not match the document/.test(e.message),
  );
});

test("provider evidence that changed the tax forces a draft recalculation", async (t) => {
  t.mock.method(db, "execute", evidenceReads([[mappedConfig()], [quoteRow()], [codeRow()]]));
  // The approved line now claims 14.00 of tax against a 13.00 quote: posting
  // revalidates instead of amending, so the draft must be recalculated.
  await assert.rejects(
    () => resolveProviderTaxPlans(doc(), [line({ taxAmount: "14.0000" })], deps()),
    (e: unknown) =>
      e instanceof PostingError &&
      /changed the tax for line 1.*recalculate the draft/.test(e.message),
  );
});

test("posting replays the frozen quote snapshot, never the party's live address", async (t) => {
  // The quote carries a Toronto destination no live read could produce, and
  // the mock allows exactly three reads (config, quote, code): any live
  // address lookup would throw "unexpected database read".
  const toronto = {
    line1: "1 Yonge St",
    city: "Toronto",
    region: "ON",
    postalCode: "M5E 1E5",
    country: "CA",
  };
  t.mock.method(
    db,
    "execute",
    evidenceReads([[mappedConfig()], [quoteRow({ ship_to: toronto })], [codeRow()]]),
  );
  const plans = await resolveProviderTaxPlans(doc(), [line()], deps());
  assert.equal(plans.length, 1);
});

test("the document's own location change is detected against the snapshot", () => {
  const snapshot = {
    shipFrom: {},
    shipTo: { line1: "1 Yonge St", city: "Toronto", region: "ON", postalCode: "M5E 1E5", country: "CA" },
  };
  assert.equal(documentLocationChange(null, snapshot), null);
  assert.equal(documentLocationChange({}, snapshot), null);
  assert.equal(
    documentLocationChange({ taxProviderAddresses: { shipTo: { ...snapshot.shipTo } } }, snapshot),
    null,
  );
  assert.equal(
    documentLocationChange(
      { taxProviderAddresses: { shipTo: { ...snapshot.shipTo, region: "QC" } } },
      snapshot,
    ),
    "shipTo address changed after the quote",
  );
  assert.equal(
    documentLocationChange({ taxProviderAddresses: "Toronto" }, snapshot),
    "tax location override is not an object",
  );
});

test("evidence maps to configs preserving the stored recovery ratio", () => {
  const [config] = taxConfigsFromEvidence([component()]);
  assert.ok(config);
  assert.equal(config.taxCodeId, "TAX-ON");
  assert.equal(config.ratePercent, "13");
  assert.equal(config.recoverablePercent, "100.0000");
  assert.equal(config.calculationType, "standard");
  assert.equal(config.roundingScale, 2);
});

test("a zero-tax component keeps an explicit full-recovery config", () => {
  const [config] = taxConfigsFromEvidence([
    component({ taxAmount: "0.0000", recoverableAmount: "0.0000" }),
  ]);
  assert.ok(config);
  assert.equal(config.recoverablePercent, "100");
});

test("a half-recoverable component keeps its fifty-percent ratio", () => {
  const [config] = taxConfigsFromEvidence([
    component({ taxAmount: "10.0000", recoverableAmount: "5.0000" }),
  ]);
  assert.ok(config);
  assert.equal(config.recoverablePercent, "50.0000");
});
