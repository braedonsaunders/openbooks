import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C-71: the export route called computeTaxReturn with NO scope opts while
// the view sent no scope params, so exporting a scoped or translated preview
// downloaded the org-wide untranslated return, contradicting the preview.
// The export now takes the same scope and translation params as the preview
// through the same shared parser, and the view passes the preview's echoed
// scope. Pinned against the stub: a scoped and translated export must reach
// the engine with the preview-identical opts, and the download must carry
// the preview's boxes.
const stateKey = Symbol.for("openbooks.tax-return-export-route-test");
interface ExportCall {
  orgId: string;
  formCode: string;
  from: string;
  to: string;
  adjustments: Record<string, string>;
  opts: Record<string, unknown>;
}
interface RouteState {
  calls: ExportCall[];
}
const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const allowed = new Set(['sub-allowed'])
      export async function guardPermission(permission) {
        if (permission !== 'reports.read') {
          throw new Error('unexpected permission gate: ' + permission)
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: allowed }
      }
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        if (subsidiaryId === null) return { status: 404, json: async () => ({ error: 'not found' }) }
        if (!authz.allowedSubsidiaryIds.has(subsidiaryId)) {
          return { status: 404, json: async () => ({ error: 'not found' }) }
        }
        return null
      }
    `,
  ],
  [
    "mock:tax-return",
    `
      const state = globalThis[Symbol.for('openbooks.tax-return-export-route-test')]
      export async function computeTaxReturn(orgId, formCode, from, to, adjustments, opts) {
        state.calls.push({ orgId, formCode, from, to, adjustments, opts: opts ?? null })
        return {
          formCode, formName: 'Form ' + formCode, from, to,
          submissionChannel: 'portal_manual', watermark: null,
          boxes: [{ lineCode: '1', label: 'Probe box', value: '20.0000', computed: false, editable: false, pdfField: null }],
        }
      }
    `,
  ],
  [
    // Only the official-pdf lookup may query the database; any other query
    // proves a format under test escaped its stubbed surface.
    "mock:db",
    `
      const sqlText = (query) => {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return ''
        return chunks
          .map((c) => {
            if (typeof c === 'string') return c
            if (Array.isArray(c?.value)) return c.value.map(String).join('')
            if (c?.queryChunks) return sqlText(c)
            return ''
          })
          .join('')
      }
      export const db = {
        async execute(query) {
          if (sqlText(query).includes('official_pdf_file_id')) {
            return { rows: [{ official_pdf_file_id: 'file-1' }] }
          }
          throw new Error('unexpected database query')
        },
      }
      export async function withBypassContext(work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withOrg(orgId, work) { return work() }
      export async function withOrgContext(orgId, work) { return work() }
      export async function inDbTransaction(work) { return work({ execute() { throw new Error('unexpected database query') } }) }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday() { return '2026-07-31' }
      export function civilDateFromParts() { throw new Error('unexpected civil date') }
    `,
  ],
  [
    "mock:intl",
    `export async function getTranslations() { return (key) => key }`,
  ],
  // Formats under test (json) never render PDFs, hit the file cabinet, or
  // build tabular exports: stub those surfaces so the test links only the
  // scope/adjustment parsing it exercises.
  [
    "mock:report-pdf",
    `
      export function exportDataToCsv() { throw new Error('unexpected csv export') }
      export async function exportDataToPdf() { throw new Error('unexpected pdf export') }
      export async function exportDataToXlsx() { throw new Error('unexpected xlsx export') }
      export async function orgBranding() { throw new Error('unexpected branding') }
      export function resolveLayout() { throw new Error('unexpected layout') }
    `,
  ],
  [
    "mock:tax-filing",
    `export function taxReturnExportData() { throw new Error('unexpected tabular export') }`,
  ],
  [
    "mock:facsimile",
    `export async function renderTaxFormFacsimilePdf() { throw new Error('unexpected facsimile') }`,
  ],
  [
    "mock:file-cabinet",
    `
      export async function getFileBlob() {
        const bytes = globalThis.__exportPdfBytes
        if (!bytes) throw new Error('unexpected file read')
        return { bytes }
      }
    `,
  ],
  [
    "mock:pdf-renderer",
    `export function rendererUnavailableResponse() { return null }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["@openbooks/engine/src/tax-returns/return.ts", "mock:tax-return"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["next-intl/server", "mock:intl"],
  ["../../../../../../lib/report-pdf", "mock:report-pdf"],
  ["../../../../../../lib/tax-filing", "mock:tax-filing"],
  ["../../../../../../lib/tax-form-facsimile", "mock:facsimile"],
  ["../../../../../../lib/file-cabinet", "mock:file-cabinet"],
  ["../../../../../../lib/api/pdf-renderer", "mock:pdf-renderer"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function get(query: string): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/tax/returns/CA_GST34/export${query}`),
    { params: Promise.resolve({ code: "CA_GST34" }) },
  ) as Promise<Response>;
}

test("GET forwards a scoped and translated preview's scope to the engine", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&format=json&subsidiary=sub-allowed" +
      "&registration=reg-1&presentationCurrency=CAD&rateType=spot&rateDate=2026-07-31",
  );

  assert.equal(response.status, 200);
  assert.equal(routeState.calls.length, 1);
  // Preview-identical opts: the same shared parser output the preview GET
  // passes, so the download computes exactly what the preview showed.
  assert.deepEqual(routeState.calls[0]!.opts, {
    filingEntity: { subsidiaryIds: ["sub-allowed"], registrationId: "reg-1" },
    translation: { presentationCurrency: "CAD", rateType: "spot", rateDate: "2026-07-31" },
  });
  const body = await response.json();
  assert.equal(body.boxes[0].value, "20.0000");
});

test("GET refuses an out-of-scope subsidiary without reaching the engine", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&format=json&subsidiary=sub-nope",
  );

  assert.equal(response.status, 404);
  assert.equal(routeState.calls.length, 0);
});

test("GET refuses an unreadable adjustment by name without reaching the engine", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&format=json&subsidiary=sub-allowed&adj_109=12,34",
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.ok(body.error.includes("adjustment 109"), body.error);
  assert.equal(routeState.calls.length, 0);
});
