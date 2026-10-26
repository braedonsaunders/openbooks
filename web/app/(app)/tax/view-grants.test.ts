import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C-70: the tax page gated Save snapshot and mark-filed on reports.create
// while the save/file routes demand compliance.file — so a reports.create
// holder saw actions that 403, and a compliance.file holder never saw them.
// Both flags now derive from the route's own permission constant (a single
// symbol, no duplicated literal). Loader-proved with each grant.

const stateKey = Symbol.for("openbooks.tax-view-grants-test");
interface ViewState {
  grants: Set<string>;
  filingCount: number;
  failedCount: number;
  adjustments: unknown;
  forms: Record<string, unknown>[];
  disabledFormCodes: Set<string>;
  filteredFormsFor: string[];
}
const viewState: ViewState = {
  grants: new Set(),
  filingCount: 0,
  failedCount: 0,
  adjustments: {},
  forms: [],
  disabledFormCodes: new Set(),
  filteredFormsFor: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = viewState;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      const value = (c as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c);
      return "";
    })
    .join("");
}

const FILING_ROW = {
  id: "f1",
  form_name: "GST/HST Return",
  form_code: "CA_GST34",
  country: "CA",
  period_from: "2026-01-01",
  period_to: "2026-03-31",
  version: 1,
  status: "prepared",
  filing_reference: null,
  filed_at: null,
  snapshot_hash: "hash-1",
  boxes: [],
  created_at: "2026-04-01T00:00:00Z",
};

const authzMock = `
      const state = globalThis[Symbol.for('openbooks.tax-view-grants-test')]
      export async function requirePermission(permission) {
        if (!state.grants.has(permission)) throw new Error('forbidden: ' + permission)
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: state.grants }
      }
      export function can(authz, permission) {
        return state.grants.has(permission)
      }
      export async function guardPermission(permission) {
        if (!state.grants.has(permission)) throw new Error('forbidden: ' + permission)
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: state.grants }
      }
      export function guardSubsidiaryScope() { return null }
    `;
const intlMock = `export async function getTranslations() { return (key) => key }`;
const navigationMock = `export function notFound() { throw new Error('notFound') }
     export function redirect(url) { throw new Error('redirect:' + url) }`;

const mockSources = new Map<string, string>([
  [
    "mock:migration-plan",
    `export async function readMigrationPlan(){ return {cutoverDate: '2025-09-01'} }`,
  ],
  [
    "mock:viewspec",
    `
      export function page(spec) { return spec }
      export function ref() { return () => false }
      export function badge() { return {} }
      export function column() { return {} }
      export function field(path) { return { $: path } }
      export function link() { return {} }
      export function number() { return {} }
      export function pageHeader(spec) { return spec }
      export function text() { return {} }
      export function widget(kind, props) { return { kind, props } }
      export function widgetBlock(kind, props) { return { kind, ...props } }
      export function table(spec) { return spec }
      export function resolvePath(root, path) { return path.split('.').reduce((value, key) => value?.[key], root) }
    `,
  ],
  [
    "mock:db",
    `
      export const db = {
        async execute(query) {
          const text = (${sqlText.toString()})(query)
          const state = globalThis[Symbol.for('openbooks.tax-view-grants-test')]
          if (text.includes('from tax_return_forms')) return { rows: state.forms }
          if (text.includes('where id')) return { rows: [{ ...${JSON.stringify(FILING_ROW)}, adjustments: state.adjustments }] }
          if (text.includes('from users')) return { rows: [{id: '11111111-1111-4111-8111-111111111111', name: 'Tax preparer'}] }
          if (text.includes('count(*)') && text.includes('tax_filings')) return { rows: [{ count: state.filingCount }] }
          if (text.includes('count(*)')) return { rows: [{ count: state.failedCount }] }
          return { rows: [] }
        },
      }
      export function ambientTenantOrgId() { return null }
      export function currentRequestOrgResolver() { return null }
      export function registerRequestOrgResolver() {}
      export async function withBypass(work) { return work() }
      export async function withBypassContext(work) { return work() }
    `,
  ],
  [
    "mock:tax-return",
    `
      const state = globalThis[Symbol.for('openbooks.tax-view-grants-test')]
      export async function computeTaxReturn() { throw new Error('unexpected compute') }
      export async function filterTaxReturnFormsByFeatures(orgId, forms) {
        state.filteredFormsFor.push(orgId)
        return forms.filter((form) => !state.disabledFormCodes.has(form.code))
      }
    `,
  ],
  [
    "mock:tax-filing",
    `
      export const TAX_FILING_SNAPSHOT_VERSION = 2
      export function buildTaxFilingSnapshot() { throw new Error('unexpected snapshot') }
    `,
  ],
  ["mock:tax-nexus-ledger", `export async function loadOrgFilingCalendar() { return [] }`],
  ["mock:business-date", `export async function businessToday() { return '2026-08-24' }`],
]);

const mockUrls = new Map<string, string>([
  ["../../../lib/migration/plan", "mock:migration-plan"],
  ["@openbooks/engine/platform/db", "mock:db"],
  ["@openbooks/engine/tax-returns/return", "mock:tax-return"],
  ["@openbooks/engine/tax-returns/filing", "mock:tax-filing"],
  ["@openbooks/engine/tax/nexus-ledger", "mock:tax-nexus-ledger"],
  ["@openbooks/engine/platform/business-date/module", "mock:business-date"],
  ["@braedonsaunders/appkit-viewspec", "mock:viewspec"],
]);

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({
  navigation: navigationMock,
  intl: intlMock,
  authz: authzMock,
  features: { enabled: ["crossBorderTax"] },
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const viewUrl = "./view.ts?tax-view-grants-test";
const { loadTax } = (await import(viewUrl)) as typeof import("./view.ts");
hooks.deregister();

function reset(grants: string[]): void {
  viewState.grants = new Set(grants);
  viewState.forms = [];
  viewState.disabledFormCodes = new Set();
  viewState.filteredFormsFor = [];
}

for (const [name, grants, expected] of [
  [
    "a reports.create holder sees no save or file action",
    ["reports.read", "reports.create"],
    false,
  ],
  ["a compliance.file holder sees the save action", ["reports.read", "compliance.file"], true],
] as Array<[string, string[], boolean]>) {
  test(name, async () => {
    reset(grants);

    const data = await loadTax({});

    assert.equal(data.canSave, expected);
  });
}

test("mark-filed follows the filing grant on the history drawer", async () => {
  for (const [grants, expected] of [
    [["reports.read", "reports.create"], false],
    [["reports.read", "compliance.file"], true],
  ] as Array<[string[], boolean]>) {
    reset(grants);
    const data = await loadTax({ filing: "11111111-1111-4111-8111-111111111111" });
    assert.equal(data.drawer?.canFile, expected);
  }
});

test("the History badge counts the filings the list shows; Activity counts failed commits", async () => {
  viewState.filingCount = 2;
  viewState.failedCount = 1;
  reset(["reports.read"]);
  for (const sp of [{}, { tab: "history" }]) {
    const data = await loadTax(sp);
    assert.equal(data.tabs.find((tab) => tab.key === "history")?.count, 2);
    assert.equal(data.tabs.find((tab) => tab.key === "activity")?.count, 1);
    assert.equal(data.history.total, 2);
  }
});

test("the prepare surface receives the organization conversion date", async () => {
  reset(["reports.read"]);
  assert.equal((await loadTax({})).conversionDate, "2025-09-01");
});

test("the form selector excludes forms whose owning feature is disabled", async () => {
  reset(["reports.read"]);
  viewState.forms = [
    {
      code: "CA_GST34",
      name: "GST/HST Return",
      country: "CA",
      submission_channel: "manual",
      government_format: "csv",
      submission_url: null,
      notice_key: null,
      has_official: false,
    },
    {
      code: "US_990",
      name: "Form 990",
      country: "US",
      submission_channel: "manual",
      government_format: "xml",
      submission_url: null,
      notice_key: null,
      has_official: false,
    },
  ];
  viewState.disabledFormCodes = new Set(["US_990"]);

  const data = await loadTax({});

  assert.deepEqual(
    data.forms.map((form) => form.code),
    ["CA_GST34"],
  );
  assert.deepEqual(data.history.formOptions, [{ value: "CA_GST34", label: "GST/HST Return" }]);
  assert.deepEqual(viewState.filteredFormsFor, ["org-1"]);
});

test("history resolves governed entries and retains earlier amount-only filing evidence", async () => {
  reset(["reports.read", "compliance.file"]);
  viewState.adjustments = [
    {
      lineCode: "104",
      amount: "3018.8400",
      reason: "Pre-conversion activity",
      enteredBy: "11111111-1111-4111-8111-111111111111",
      enteredAt: "2026-08-01T12:00:00.000Z",
    },
  ];
  const prepared = await loadTax({ filing: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(prepared.drawer?.filing.adjustments, [
    {
      lineCode: "104",
      amount: "3018.8400",
      reason: "Pre-conversion activity",
      enteredByName: "Tax preparer",
      enteredAt: "2026-08-01T12:00:00.000Z",
    },
  ]);
  viewState.adjustments = { "104": "3018.8400" };
  const legacy = await loadTax({ filing: "11111111-1111-4111-8111-111111111111" });
  assert.deepEqual(legacy.drawer?.filing.adjustments, [
    { lineCode: "104", amount: "3018.8400", reason: null, enteredByName: null, enteredAt: null },
  ]);
  viewState.adjustments = {};
});
