import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { orgId: "org", grants: new Set<string>(["items.read"]) };
Object.assign(globalThis, { __inventoryViewPermissions: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next-intl/server") return virtual("export async function getTranslations() { return (key) => key }");
    if (specifier === "next/link") return virtual("export default function Link(p) { return globalThis.React.createElement('a', { href: p.href }, p.children) }");
    if (specifier === "lucide-react") return virtual("export function Plus() { return null }");
    if (specifier === "@openbooks/ui") return virtual("export function Button(p) { return globalThis.React.createElement('button', null, p.children) } export function PageHeader(p) { return globalThis.React.createElement('header', null, p.actions) }");
    if (specifier === "@openbooks/engine/src/platform/db.ts") return virtual("export const db = { execute: async () => ({ rows: [] }) }");
    if (specifier === "@openbooks/engine/src/inventory/stock-count-queries.ts") return virtual("export async function listStockCounts() { return { counts: [], totalCount: 0, nextCursor: null } }");
    if (specifier === "@openbooks/engine/src/inventory/stock-count-gates.ts") return virtual("export async function isStockCountReviewRequired() { return false }");
    if (specifier === "../../../components/entity-list-view") return virtual("export function EntityListView() { return null }");
    if (specifier === "../../../components/page-layout") return virtual("export function ListPageLayout(p) { return globalThis.React.createElement('main', null, p.header, p.children) }");
    if (specifier === "../../../components/module-home/ui") return virtual("export function ModuleHomeTabs() { return null }");
    if (specifier === "../admin/setup/[entity]/SetupEntitySection") return virtual("export function SetupEntitySection() { return null }");
    if (specifier === "./BomWorkspace") return virtual("export function BomWorkspace() { return null } export function NewBomButton() { return null }");
    if (specifier === "./counts/CountsList") return virtual("export function CountsList() { return null } export function NewCountButton() { return null }");
    if (specifier === "./InventoryActionDrawer") return virtual("export function InventoryActionDrawer() { return null }");
    if (specifier === "./NewMovementButton") return virtual("export function NewMovementButton() { return null }");
    if (specifier === "./ReverseLandedVoucherAction") return virtual("export function ReverseLandedVoucherAction() { return globalThis.React.createElement('span', null, 'REVERSAL_ACTION') }");
    if (specifier === "./movement-permissions") return virtual("export function canPostInventoryMovement(authz) { return authz.permissions.has('items.post') }");
    if (specifier === "../../../lib/setup/registry") return virtual("export const SETUP_ENTITY_BY_KEY = new Map()");
    if (specifier === "@braedonsaunders/appkit-viewspec") return virtual("export const page = () => ({}); export const pageHeader = () => ({}); export const ref = () => () => ({}); export const widget = () => ({}); export const widgetBlock = () => ({})");
    if (specifier === "../../../lib/authz") return virtual(`
      export async function requirePermission() {
        const s = globalThis.__inventoryViewPermissions;
        return { user: { orgId: s.orgId, id: "actor" }, permissions: s.grants, allowedSubsidiaryIds: null };
      }
      // Exact-match check: the cases below use concrete grants, so the
      // production wildcard semantics change nothing about them.
      export function can(authz, perm) { return authz.permissions.has(perm) }
    `);
    if (specifier === "../../../lib/feature-gates") return virtual("export async function requireFeatureEnabled() { return undefined }");
    return next(specifier, context);
  },
});

const { loadInventory } = await import("./view.ts");

const React = await import("react");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const { renderToStaticMarkup } = await import("react-dom/server");
const { default: InventoryPage } = await import("./page.tsx");

async function showsNewMovement(grants: string[]): Promise<unknown> {
  state.grants = new Set(grants);
  return (await loadInventory({})).showNewMovement;
}

test("the New-movement button follows the posting grant, not the manage grant", async () => {
  // An items.post-only user sees and can open the drawer; posting needs
  // items.post while the button used to demand items.manage.
  assert.equal(await showsNewMovement(["items.read", "items.post"]), true);
  // An items.manage-only user must not see a drawer they cannot submit —
  // the route would 403 on post.
  assert.equal(await showsNewMovement(["items.read", "items.manage"]), false);
  assert.equal(await showsNewMovement(["items.read"]), false);
  assert.equal(await showsNewMovement(["items.read", "items.reverse"]), false);
});

test("the landed-cost reversal action is visible only with the reversal grant", async () => {
  async function hasReversalAction(grants: string[]): Promise<boolean> {
    state.grants = new Set(grants);
    const page = await InventoryPage({ searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(page).includes("REVERSAL_ACTION");
  }

  assert.equal(await hasReversalAction(["items.read", "items.reverse"]), true);
  assert.equal(await hasReversalAction(["items.read"]), false);
  assert.equal(await hasReversalAction(["items.read", "items.manage"]), false);
});
