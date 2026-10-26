import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.continuous-close-pdf-calendar-test");
const state: { generatedAt?: Date; filename?: string } = {};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const stamp = "2026-03-15";
const mockSources = new Map<string, string>([
  [
    "mock:intl",
    `export async function getTranslations() { return (key) => key }; export async function getLocale() { return 'en-US' }`,
  ],
  [
    "mock:business-date",
    `export async function businessToday(orgId) { if (orgId !== 'org-1') throw new Error('wrong organization'); return '${stamp}' }`,
  ],
  [
    "mock:db",
    `export * from ${JSON.stringify(import.meta.resolve("@openbooks/engine/platform/db"))}; export const ambientTenantOrgId=()=>null; export const currentRequestOrgResolver=()=>null; export const registerRequestOrgResolver=()=>{}; export const withBypass=(fn)=>fn(); export const withBypassContext=(fn)=>fn(); export const db = { async execute(_query, mode) { const inMode = (result) => (mode === 'objects' ? result.rows : result); return inMode({ rows: [{ agent_key: 'accounting', finished_at: new Date('2026-03-14T23:59:00Z'), narrative: { title: 'Close review', periodLabel: 'March close', executiveSummary: 'Two risks need review.' } }] }) } }`,
  ],
  [
    "mock:feature-gate",
    `export async function guardFeaturePermission() { return { user: { orgId: 'org-1' } } }`,
  ],
  ["mock:authz", `export function guardUnrestrictedScope() { return null }`],
  [
    "mock:continuous-close",
    `export function readableContinuousCloseAgents() { return ['accounting'] }`,
  ],
  [
    "mock:export",
    `export function pdfResponse(bytes, filename) { globalThis[Symbol.for('openbooks.continuous-close-pdf-calendar-test')].filename = filename; return new Response(bytes) }; export function safeName(value) { return value }`,
  ],
  [
    "mock:report-pdf",
    `const state = globalThis[Symbol.for('openbooks.continuous-close-pdf-calendar-test')]; export async function exportDataToPdf(_data, _branding, _layout, options) { state.generatedAt = options.generatedAt; return Buffer.from('pdf') }; export async function orgBranding() { return {} }`,
  ],
  ["mock:pdf", `export function resolvePdfPageSetup() { return {} }`],
]);

const mockUrls = new Map<string, string>([
  ["next-intl/server", "mock:intl"],
  ["@openbooks/engine/platform/business-date/module", "mock:business-date"],
  ["@openbooks/engine/platform/db", "mock:db"],
  ["@openbooks/pdf", "mock:pdf"],
  ["../../../../../../lib/feature-gates", "mock:feature-gate"],
  ["@/lib/feature-gates", "mock:feature-gate"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/continuous-close", "mock:continuous-close"],
  ["../../../../../../lib/export", "mock:export"],
  ["../../../../../../lib/report-pdf", "mock:report-pdf"],
]);

registerHooks({
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

const { GET } = await import("../app/api/continuous-close/reports/[runId]/pdf/route.ts");

test("continuous-close report PDFs stamp generation with the organization business day", async () => {
  const response = await GET(new Request("http://openbooks.test"), {
    params: Promise.resolve({ runId: "11111111-1111-4111-8111-111111111111" }),
  });

  assert.equal(response.status, 200);
  assert.equal(state.generatedAt?.toISOString(), `${stamp}T00:00:00.000Z`);
  assert.ok(
    state.filename?.includes(stamp),
    "the download name carries the same business-day stamp",
  );
});
