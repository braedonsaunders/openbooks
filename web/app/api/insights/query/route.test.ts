import { featureEnabled } from "@openbooks/engine/organization/feature-registry";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { intlServerStubSource } from "../../../../testing/stub-modules";
import { can, type Authz } from "../../../../lib/authz-core";
import { requestAuthzContext } from "../../../../lib/authz-context";

const key = Symbol.for("openbooks.insight-query-context-test");
const observations: { phase: string; orgId: string | undefined }[] = [];
const state = {
  featureEnabled,
  can,
  observe(phase: string) {
    const orgId = requestAuthzContext()?.user.orgId;
    observations.push({ phase, orgId });
    return orgId;
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[key] = state;
const prefix = `const state=globalThis[Symbol.for('openbooks.insight-query-context-test')];`;
const mocks = new Map([
  ["@/lib/api/route", "export function defineRoute(options){return options.handler}"],
  [
    "@/lib/authz",
    `${prefix} export const can=state.can; export async function getAuthz(){throw Error('unexpected identity resolution')}`,
  ],
  ["../../../../lib/authz", `${prefix} export const can=state.can`],
  ["./authz", `${prefix} export const can=state.can`],
  ["@openbooks/engine/platform/db", "export const pool={}; export const db={}"],
  [
    "next-intl/server",
    intlServerStubSource(
      `${prefix} export async function getTranslations(namespace){state.observe('labels:'+namespace);await Promise.resolve();return key=>key}`,
    ),
  ],
  [
    "@openbooks/engine/platform/business-date/module",
    `${prefix} export async function businessToday(){state.observe('date');return '2026-10-08'}`,
  ],
  [
    "@/lib/fiscal",
    `${prefix} export async function fiscalStartMonth(){state.observe('fiscal');return 1}`,
  ],
  [
    "@/lib/custom-record-report-catalog",
    `${prefix} export async function reportEntityCatalog(){state.observe('catalog');return {}}`,
  ],
  [
    "@/lib/features",
    `${prefix} export const featureEnabled=state.featureEnabled; export async function orgFeatureState(){throw Error('unexpected catalog enumeration')}; export async function isFeatureEnabled(){state.observe('feature');return true}`,
  ],
  [
    "@/lib/insight-books",
    `${prefix} export class InsightBookScopeError extends Error{}; export async function resolveInsightBookScope(){state.observe('book');return ['primary-book']}`,
  ],
  [
    "@/lib/expense-access",
    `${prefix} export async function reportExpenseAccess(authz){state.observe('expenses');return authz.permissions.has('expenses.read')?{scope:'all'}:{scope:'none'}}`,
  ],
  [
    "@openbooks/analytics/server",
    `${prefix} export class InsightDenominationError extends Error{}; export async function runInsightQuery(pool,query,orgId,subsidiaries,labels,today,books,catalog,startMonth,expenseAccess){state.observe('execution');return {orgId,subsidiaries,books,label:labels.count(),today,expenseAccess}}`,
  ],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (mocks.has(specifier)) return { shortCircuit: true, url: `mock:insight-query:${specifier}` };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("mock:insight-query:"))
      return {
        shortCircuit: true,
        format: "module",
        source: mocks.get(url.slice("mock:insight-query:".length))!,
      };
    return next(url, context);
  },
});
const { POST } = await import("./route");
const handler = POST as unknown as (args: { authz: Authz; body: unknown }) => Promise<Response>;
const principal = (orgId: string): Authz =>
  ({
    user: { orgId, id: `reader-${orgId}` },
    permissions: new Set(["insights.read"]),
    allowedSubsidiaryIds: new Set([`${orgId}-entity`]),
  }) as Authz;
const body = (source = "ledger_lines") => ({
  query: { source, measures: [{ agg: "count" }], dimensions: [], filters: [] },
  allowedSubsidiaryIds: ["foreign-entity"],
});

test("concurrent query preparations use their verified tenants and execution retains server-owned scope", async () => {
  observations.length = 0;
  const responses = await Promise.all(
    ["company-a", "company-b"].map((orgId) => handler({ authz: principal(orgId), body: body() })),
  );
  const values = await Promise.all(responses.map((r) => r.json()));
  assert.deepEqual(
    values.map((v) => [v.orgId, v.subsidiaries, v.books]),
    [
      ["company-a", ["company-a-entity"], ["primary-book"]],
      ["company-b", ["company-b-entity"], ["primary-book"]],
    ],
  );
  // A reader without expense read executes with no expense report rows.
  assert.deepEqual(
    values.map((v) => v.expenseAccess),
    [{ scope: "none" }, { scope: "none" }],
  );
  for (const phase of [
    "labels:insights",
    "labels:reports",
    "date",
    "fiscal",
    "catalog",
    "expenses",
  ]) {
    assert.deepEqual(
      observations
        .filter((o) => o.phase === phase)
        .map((o) => o.orgId)
        .sort(),
      ["company-a", "company-b"],
    );
  }
  for (const o of observations.filter((o) => ["book", "execution"].includes(o.phase)))
    assert.equal(o.orgId, undefined);
  assert.equal(requestAuthzContext(), undefined);
});

test("a sensitive source still refuses before preparing or executing a query", async () => {
  observations.length = 0;
  const response = await handler({ authz: principal("company-a"), body: body("pay_stubs") });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /payroll.read/);
  assert.deepEqual(observations, []);
});
