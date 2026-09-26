import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules";

const state = { orgId: "org", grants: new Set<string>(["items.read"]), allowed: null as Set<string> | null, subsidiaries: [] as Array<{ id: string; name: string }>, pickerSubsidiaries: [] as Array<{ id: string; name: string }> };
Object.assign(globalThis, { __inventoryViewPermissions: state });
stubModules({
  navigation: false,
  authz: false,
  features: false,
  extra: {
    "../../../lib/authz": `
      export async function requirePermission() {
        const s = globalThis.__inventoryViewPermissions;
        return { user: { orgId: s.orgId, id: "actor" }, permissions: s.grants, allowedSubsidiaryIds: s.allowed };
      }
      export function can(authz, perm) { return authz.permissions.has(perm) }
    `,
    "../../../lib/feature-gates": "export async function requireFeatureEnabled() { return undefined }",
    "next/link": "export default function Link(p) { return globalThis.React.createElement('a', { href: p.href }, p.children) }",
    "lucide-react": "export function Plus() { return null }",
    "@openbooks/ui": "export function Button(p) { return globalThis.React.createElement('button', null, p.children) } export function PageHeader(p) { return globalThis.React.createElement('header', null, p.actions) }",
    "@openbooks/engine/src/platform/db.ts": "export const db = { execute: async () => ({ rows: globalThis.__inventoryViewPermissions.subsidiaries }) }; export function ambientTenantOrgId() { return globalThis.__inventoryViewPermissions.orgId }; export async function withBypassContext(fn) { return fn() }",
    "@openbooks/engine/src/inventory/stock-count-queries.ts": "export async function listStockCounts() { return { counts: [], totalCount: 0, nextCursor: null } }",
    "@openbooks/engine/src/inventory/stock-count-gates.ts": "export async function isStockCountReviewRequired() { return false }",
    "../../../components/entity-list-view": "export function EntityListView() { return null }",
    "../../../components/page-layout": "export function ListPageLayout(p) { return globalThis.React.createElement('main', null, p.header, p.children) }",
    "../../../components/module-home/ui": "export function ModuleHomeTabs() { return null }",
    "../admin/setup/[entity]/SetupEntitySection": "export function SetupEntitySection() { return null }",
    "./BomWorkspace": "export function BomWorkspace() { return null } export function NewBomButton() { return null }",
    "./counts/CountsList": "export function CountsList(p) { globalThis.__inventoryViewPermissions.pickerSubsidiaries = p.subsidiaries; return null } export function NewCountButton() { return null }",
    "./InventoryActionDrawer": "export function InventoryActionDrawer() { return null }",
    "./NewMovementButton": "export function NewMovementButton() { return null }",
    "./ReverseLandedVoucherAction": "export function ReverseLandedVoucherAction() { return globalThis.React.createElement('span', null, 'REVERSAL_ACTION') }",
    "./movement-permissions": "export function canPostInventoryMovement(authz) { return authz.permissions.has('items.post') }",
    "../../../lib/setup/registry": "export const SETUP_ENTITY_BY_KEY = new Map()",
    "@braedonsaunders/appkit-viewspec": "export const page = () => ({}); export const pageHeader = () => ({}); export const ref = () => () => ({}); export const widget = () => ({}); export const widgetBlock = () => ({})",
  },
});

const { loadInventory } = await import("./view.ts");

const React = await import("react");
Object.assign(globalThis, { React });
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
});

test("the landed-cost reversal action is visible only with the reversal grant", async () => {
  async function hasReversalAction(grants: string[]): Promise<boolean> {
    state.grants = new Set(grants);
    const page = await InventoryPage({ searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(page).includes("REVERSAL_ACTION");
  }

  assert.equal(await hasReversalAction(["items.read", "items.reverse"]), true);
  assert.equal(await hasReversalAction(["items.read"]), false);
  state.allowed = new Set(["A"]); state.subsidiaries = [{ id: "A", name: "Visible" }, { id: "B", name: "Hidden" }];
  renderToStaticMarkup(await InventoryPage({ searchParams: Promise.resolve({ inventoryView: "counts" }) })); assert.deepEqual(state.pickerSubsidiaries.map(({ id }) => id), ["A"]);
  state.allowed = null;
});
