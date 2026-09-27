import assert from "node:assert/strict";
import { stubModules } from "../../../../../../testing/stub-modules";
import test from "node:test";
import { PDFDocument } from "pdf-lib";

declare global {
  var __exportBoxes:
    | Array<{
        lineCode: string;
        label: string;
        value: string;
        computed: boolean;
        editable: boolean;
        pdfField: string | null;
      }>
    | undefined;
  var __exportPdfBytes: Uint8Array | undefined;
}

/** A minimal AcroForm PDF carrying exactly the named text fields. */
async function acroFormPdf(fieldNames: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const form = doc.getForm();
  fieldNames.forEach((name, index) => {
    form.createTextField(name).addToPage(page, { x: 50, y: 700 - index * 40, width: 200, height: 20 });
  });
  return doc.save();
}

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

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../../lib/authz": `
      const allowed = new Set(['sub-allowed'])
      export async function guardPermission(permission) {
        if (permission !== 'reports.read') {
          throw new Error('unexpected permission gate: ' + permission)
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: allowed }
      }
      export async function getAuthz() { return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: allowed } }
      export function guardRootSubsidiaryScope() { return null }
      export function guardUnrestrictedScope() { return null }
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        if (subsidiaryId === null) return { status: 404, json: async () => ({ error: 'not_found' }) }
        if (!authz.allowedSubsidiaryIds.has(subsidiaryId)) {
          return { status: 404, json: async () => ({ error: 'not_found' }) }
        }
        return null
      }
    `,
    "@/lib/authz": `
      const allowed = new Set(['sub-allowed'])
      export async function getAuthz() { return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: allowed } }
      export async function guardPermission() { return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: allowed } }
      export function guardRootSubsidiaryScope() { return null }
      export function guardUnrestrictedScope() { return null }
    `,
    "@openbooks/engine/src/tax-returns/return.ts": `
      const state = globalThis[Symbol.for('openbooks.tax-return-export-route-test')]
      export async function computeTaxReturn(orgId, formCode, from, to, adjustments, opts) {
        state.calls.push({ orgId, formCode, from, to, adjustments, opts: opts ?? null })
        return {
          formCode, formName: 'Form ' + formCode, from, to,
          submissionChannel: 'portal_manual', watermark: null,
          boxes: globalThis.__exportBoxes ?? [{ lineCode: '1', label: 'Probe box', value: '20.0000', computed: false, editable: false, pdfField: null }],
        }
      }
    `,
    "@openbooks/engine/src/platform/db.ts": `
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
      export function ambientTenantOrgId() { return null }
    `,
    "@openbooks/engine/src/platform/business-date.ts": `
      export async function businessToday() { return '2026-07-31' }
      export function civilDateFromParts() { throw new Error('unexpected civil date') }
    `,
    "next-intl/server": `export async function getTranslations() { return (key) => key }`,
    "../../../../../../lib/report-pdf": `
      export function exportDataToCsv() { throw new Error('unexpected csv export') }
      export async function exportDataToPdf() { throw new Error('unexpected pdf export') }
      export async function exportDataToXlsx() { throw new Error('unexpected xlsx export') }
      export async function orgBranding() { throw new Error('unexpected branding') }
      export function resolveLayout() { throw new Error('unexpected layout') }
    `,
    "../../../../../../lib/tax-filing": `export function taxReturnExportData() { throw new Error('unexpected tabular export') }`,
    "../../../../../../lib/tax-form-facsimile": `export async function renderTaxFormFacsimilePdf() { throw new Error('unexpected facsimile') }`,
    "../../../../../../lib/file-cabinet": `
      export async function getFileBlob() {
        const bytes = globalThis.__exportPdfBytes
        if (!bytes) throw new Error('unexpected file read')
        return { bytes }
      }
    `,
    "../../../../../../lib/api/pdf-renderer": `export function rendererUnavailableResponse() { return null }`,
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

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

test("GET official refuses by name when a non-zero box is unmatched", async () => {
  globalThis.__exportBoxes = [
    { lineCode: "109", label: "Net tax", value: "20.0000", computed: false, editable: false, pdfField: "FIELD_109" },
  ];
  globalThis.__exportPdfBytes = await acroFormPdf(["WRONG_FIELD"]);
  try {
    const response = await get("?from=2026-07-01&to=2026-07-31&format=official&subsidiary=sub-allowed");

    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error.includes("109 (FIELD_109)"), body.error);
    assert.ok(body.error.includes("re-upload"), body.error);
  } finally {
    globalThis.__exportBoxes = undefined;
    globalThis.__exportPdfBytes = undefined;
  }
});

test("GET official downloads when every mapped field matches", async () => {
  globalThis.__exportBoxes = [
    { lineCode: "109", label: "Net tax", value: "20.0000", computed: false, editable: false, pdfField: "FIELD_109" },
  ];
  globalThis.__exportPdfBytes = await acroFormPdf(["FIELD_109"]);
  try {
    const response = await get("?from=2026-07-01&to=2026-07-31&format=official&subsidiary=sub-allowed");

    assert.equal(response.status, 200);
    assert.ok(
      response.headers.get("content-type")?.includes("pdf"),
      response.headers.get("content-type") ?? "missing content-type",
    );
  } finally {
    globalThis.__exportBoxes = undefined;
    globalThis.__exportPdfBytes = undefined;
  }
});

test("GET official downloads when only zero boxes are unmatched", async () => {
  globalThis.__exportBoxes = [
    { lineCode: "109", label: "Net tax", value: "0.0000", computed: false, editable: false, pdfField: "FIELD_109" },
  ];
  globalThis.__exportPdfBytes = await acroFormPdf(["WRONG_FIELD"]);
  try {
    const response = await get("?from=2026-07-01&to=2026-07-31&format=official&subsidiary=sub-allowed");

    assert.equal(response.status, 200);
  } finally {
    globalThis.__exportBoxes = undefined;
    globalThis.__exportPdfBytes = undefined;
  }
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
