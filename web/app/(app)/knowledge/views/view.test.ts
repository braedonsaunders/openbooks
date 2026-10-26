import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const PRIVATE_PAYROLL_VIEW = "00000000-0000-4000-8000-000000000041";
const SHARED_LEDGER_VIEW = "00000000-0000-4000-8000-000000000042";

const state = {
  authz: {
    user: { id: "reader-1", orgId: "org-1" },
    permissions: new Set(["reports.read", "reports.*", "!reports.create"]),
  },
  views: [
    {
      id: PRIVATE_PAYROLL_VIEW,
      name: "Payroll forecast",
      description: "Restricted plan",
      query: { entity: "payroll_earnings" },
      scope: "shared",
      owner_id: "owner-2",
      updated_at: "2026-01-02T00:00:00.000Z",
    },
    {
      id: SHARED_LEDGER_VIEW,
      name: "Ledger review",
      description: null,
      query: { entity: "ledger_lines" },
      scope: "shared",
      owner_id: "owner-2",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  hiddenEntityKeys: ["payroll_earnings", "project_costs"],
  features: new Set<string>(),
};
Object.assign(globalThis, { __knowledgeViewsPageState: state });

const sources = new Map<string, string>([
  ["mock:server-only", "export {}"],
  [
    "mock:viewspec",
    `export const pagination=()=>({}); export const badge=()=>({}); export const column=()=>({});
     export const field=()=>({}); export const grid=()=>({}); export const page=()=>({});
     export const pageHeader=()=>({}); export const ref=()=>({}); export const rootRef=()=>({});
     export const text=()=>({}); export const widget=()=>({}); export const widgetBlock=()=>({});
     export const widgetCell=()=>({});`,
  ],
  [
    "mock:intl",
    `export async function getTranslations(){const t=(key)=>key;t.has=()=>true;return t}`,
  ],
  [
    "mock:list-params",
    `export function pickString(value){return typeof value==='string'?value:Array.isArray(value)?value[0]:undefined}
     export function parseListParams(sp){return {q:typeof sp.q==='string'?sp.q:undefined,sort:sp.sort==='name'?'name':'updated',dir:sp.dir==='asc'?'asc':'desc',page:1}}`,
  ],
  ["mock:format", `export function dateTime(value){return value}`],
  [
    "mock:authz",
    `const state=globalThis.__knowledgeViewsPageState;
     export async function requirePermission(){return state.authz}
     export function can(authz,perm){const p=authz.permissions;if(p.has('!'+perm))return false;if(p.has('*'))return true;if(p.has(perm))return true;for(const grant of p){if(grant.endsWith('.*')&&perm.startsWith(grant.slice(0,-1)))return true}return false}`,
  ],
  [
    "mock:features",
    `const state=globalThis.__knowledgeViewsPageState;
     export async function isFeatureEnabled(_orgId,key){return state.features.has(key)}`,
  ],
  [
    "mock:report-authz",
    `const state=globalThis.__knowledgeViewsPageState;
     export async function canRunReportEntity(_authz,query){return !state.hiddenEntityKeys.includes(query.entity)}
     export async function hiddenReportEntityKeys(){return state.hiddenEntityKeys}`,
  ],
  [
    "mock:views",
    `const state=globalThis.__knowledgeViewsPageState;
     export async function loadViews(){return state.views}`,
  ],
  ["mock:report-pdf", `export async function orgBranding(){return {orgName:'Example Co'}}`],
  ["mock:prepared-spec", `export function registeredListTable(){return {}}`],
]);

const specifiers = new Map<string, string>([
  ["server-only", "mock:server-only"],
  ["@braedonsaunders/appkit-viewspec", "mock:viewspec"],
  ["next-intl/server", "mock:intl"],
  ["../../../../lib/list/prepared-spec", "mock:prepared-spec"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["../../../../lib/format", "mock:format"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/report-authz", "mock:report-authz"],
  ["../../../../lib/views", "mock:views"],
  ["../../../../lib/report-pdf", "mock:report-pdf"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked = specifiers.get(specifier);
    return mocked ? { url: mocked, shortCircuit: true } : nextResolve(specifier);
  },
  load(url, _context, nextLoad) {
    const source = sources.get(url);
    return source === undefined ? nextLoad(url) : { format: "module", source, shortCircuit: true };
  },
});

const { loadViewsPage } = await import("./view");
test.after(() => hooks.deregister());

test("saved view pages hide plans the reader cannot run and use effective create permission", async () => {
  const data = await loadViewsPage({ view: PRIVATE_PAYROLL_VIEW });

  assert.deepEqual(
    data.rows.map((row) => row.id),
    [SHARED_LEDGER_VIEW],
  );
  assert.equal(data.total, 1);
  assert.equal(data.studioOpen, false);
  assert.equal(data.studioProps, null);
  assert.equal(data.canCreate, false, "a runtime deny overrides the reports.* grant");
});

test("the unsaved studio receives the feature and permission filtered entity list", async () => {
  state.authz.permissions = new Set(["reports.read", "reports.create"]);

  const data = await loadViewsPage({ view: "new" });

  assert.equal(data.studioOpen, true);
  assert.deepEqual((data.studioProps as { hiddenEntityKeys: string[] }).hiddenEntityKeys, [
    "payroll_earnings",
    "project_costs",
  ]);
});
