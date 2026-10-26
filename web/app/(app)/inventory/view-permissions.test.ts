import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules";

const state = {
  orgId: "org",
  grants: new Set<string>(["items.read"]),
  allowed: null as Set<string> | null,
  subsidiaries: [] as Array<{ id: string; name: string }>,
  pickerSubsidiaries: [] as Array<{ id: string; name: string }>,
};
Object.assign(globalThis, { __inventoryViewPermissions: state });
stubModules({
  intl: true,
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
    "../../../lib/feature-gates":
      "export async function requireFeatureEnabled() { return undefined }",
    "../../../lib/features": "export async function isFeatureEnabled() { return false }",
    "next/link":
      "export default function Link(p) { return globalThis.React.createElement('a', { href: p.href }, p.children) }",
    "lucide-react": "export function Plus() { return null }",
    "@openbooks/ui":
      "export function Button(p) { return globalThis.React.createElement('button', null, p.children) } export function PageHeader(p) { return globalThis.React.createElement('header', null, p.actions) }",
    "@openbooks/engine/platform/db":
      'export const db = { execute: async (_query, mode) => Promise.resolve({ rows: globalThis.__inventoryViewPermissions.subsidiaries }).then((result) => (mode === "objects" ? result.rows : result)) }; export function ambientTenantOrgId() { return globalThis.__inventoryViewPermissions.orgId }; export async function withBypassContext(fn) { return fn() }',
    "@openbooks/engine/inventory/stock-count-queries":
      "export async function listStockCounts() { return { counts: [], totalCount: 0, nextCursor: null } }",
    "../../../components/entity-list-view": "export function EntityListView() { return null }",
    "../../../components/page-layout":
      "export function ListPageLayout(p) { return globalThis.React.createElement('main', null, p.header, p.children) }",
    "../../../components/module-home/ui": "export function ModuleHomeTabs() { return null }",
    "../../../components/viewspec/module-view":
      "export async function ModuleView(p) { return null }",
    "../admin/setup/[entity]/SetupEntitySection":
      "export function SetupEntitySection() { return null }",
    "./BomWorkspace":
      "export function BomWorkspace() { return null } export function NewBomButton() { return null }",
    "./counts/CountsList":
      "export function CountsList(p) { globalThis.__inventoryViewPermissions.pickerSubsidiaries = p.subsidiaries; return null } export function NewCountButton() { return null }",
    "./InventoryActionDrawer": "export function InventoryActionDrawer() { return null }",
    "./ReceiveAgainstPoDrawer": "export function ReceiveAgainstPoDrawer() { return null }",
    "../../../lib/receivable-purchase-orders":
      "export async function listReceivablePurchaseOrders() { return { rows: [] } }",
    "./StockControls": "export function StockControls() { return null }",
    "./LayerInquiry": "export function LayerInquiry() { return null }",
    "./NewMovementButton": "export function NewMovementButton() { return null }",
    "./ReverseLandedVoucherAction":
      "export function ReverseLandedVoucherAction() { return globalThis.React.createElement('span', null, 'REVERSAL_ACTION') }",
    "../../../lib/setup/registry": "export const SETUP_ENTITY_BY_KEY = new Map()",
    "@braedonsaunders/appkit-viewspec":
      "export const page = () => ({}); export const pageHeader = () => ({}); export const ref = () => () => ({}); export const widget = () => ({}); export const widgetBlock = () => ({})",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { default: InventoryPage } = await import("./page.tsx");

async function inventoryPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  return (await InventoryPage({
    searchParams: Promise.resolve(searchParams),
  })) as unknown as { props: { data: { workspace: Record<string, unknown> } } };
}

async function showsNewMovement(grants: string[]): Promise<unknown> {
  state.grants = new Set(grants);
  return (await inventoryPage()).props.data.workspace.canPostMovement;
}

test("the movement editor offers posting and reversal only under their respective grants", async () => {
  // An items.post-only user sees and can open the drawer; posting needs
  // items.post while the button used to demand items.manage.
  assert.equal(await showsNewMovement(["items.read", "items.post"]), true);
  // An items.manage-only user must not see a drawer they cannot submit —
  // the route would 403 on post.
  assert.equal(await showsNewMovement(["items.read", "items.manage"]), false);
  assert.equal(await showsNewMovement(["items.read", "items.reverse"]), true);
});

test("the landed-cost reversal action is visible only with the reversal grant", async () => {
  async function hasReversalGrant(grants: string[]): Promise<boolean> {
    state.grants = new Set(grants);
    return (await inventoryPage()).props.data.workspace.canReverse === true;
  }

  assert.equal(await hasReversalGrant(["items.read", "items.reverse"]), true);
  assert.equal(await hasReversalGrant(["items.read"]), false);
});

test("items readers can open the locations and BOM views while setup edits stay gated", async () => {
  state.grants = new Set(["items.read"]);
  for (const view of ["locations", "bom"]) {
    const { workspace } = (await inventoryPage({ inventoryView: view })).props.data;
    assert.equal(workspace.view, view);
    assert.equal(workspace.canSetup, false);
    assert.ok(
      (workspace.tabs as Array<{ href: string }>).some((tab) =>
        tab.href.endsWith(`inventoryView=${view}`),
      ),
    );
  }
});

test("count pickers stay scoped to the reader's allowed subsidiaries", async () => {
  state.grants = new Set(["items.read"]);
  state.allowed = new Set(["A"]);
  state.subsidiaries = [
    { id: "A", name: "Visible" },
    { id: "B", name: "Hidden" },
  ];
  const { workspace } = (await inventoryPage({ inventoryView: "counts" })).props.data;
  assert.deepEqual(
    (workspace.countSubsidiaries as Array<{ id: string }>).map(({ id }) => id),
    ["A"],
  );
  state.allowed = null;
});
