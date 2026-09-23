import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Authz } from "@/lib/authz";

// An ap.pay-only user (no admin.customization.manage) saw the New payment
// button but ?paymentNew=1 opened no drawer and showed no error: creation
// was gated on the list-VIEW customization right. Creation now gates on the
// one canCreate (ap.pay / ar.pay by kind), shared by the New buttons and the
// drawer; view customization keeps admin.customization.manage.
const stateKey = Symbol.for("openbooks.payments-section-create-gate-test");
interface SectionState {
  listProps: Record<string, unknown> | null;
}
const sectionState: SectionState = { listProps: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = sectionState;

const root = pathToFileURL(process.cwd() + "/").href;

const mockSources = new Map<string, string>([
  [
    "mock:next-navigation",
    `
      export function useRouter() { return { push() {}, refresh() {} } }
      export function useSearchParams() { return new URLSearchParams() }
      export function redirect() { throw new Error('redirect') }
    `,
  ],
  [
    "mock:next-headers",
    `export function cookies() { return { get() { return undefined } } }`,
  ],
  [
    "mock:next-intl-server",
    `export async function getTranslations() { return (key) => key }`,
  ],
  [
    "mock:engine-db",
    `
      export const db = { execute: async () => ({ rows: [] }) }
      export function ambientTenantOrgId() { return null }
      export function withBypass(_orgId, fn) { return fn(db) }
      export function withBypassContext(_ctx, fn) { return fn() }
      export function currentRequestOrgResolver() { return null }
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    "mock:payment-queries",
    `
      export async function loadPaymentDocument() { return null }
      export async function openItemsForParty() { return [] }
    `,
  ],
  [
    "mock:business-date",
    `export async function businessToday() { return '2026-07-31' }`,
  ],
  [
    "mock:form-layout",
    `export async function resolveFormLayout() { return { layout: null } }`,
  ],
  [
    "mock:payment-drawer",
    `export function PaymentDrawer() { return null }`,
  ],
  [
    "mock:record-list-view",
    `
      const state = globalThis[Symbol.for('openbooks.payments-section-create-gate-test')]
      export function RecordListView(props) {
        state.listProps = props
        return null
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["next/navigation", "mock:next-navigation"],
  ["next/headers", "mock:next-headers"],
  ["next-intl/server", "mock:next-intl-server"],
  ["@openbooks/engine/src/platform/db.ts", "mock:engine-db"],
  ["@openbooks/engine/src/payments/payment-queries.ts", "mock:payment-queries"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["./PaymentDrawer", "mock:payment-drawer"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(root + "web/" + specifier.slice(2), context);
    }
    if (
      specifier.endsWith("/components/record-list-view") ||
      specifier.endsWith("/components/record-list-view.tsx")
    ) {
      return { url: "mock:record-list-view", shortCircuit: true };
    }
    if (
      specifier.endsWith("/lib/customization/resolve") ||
      specifier.endsWith("/lib/customization/resolve.ts")
    ) {
      return { url: "mock:form-layout", shortCircuit: true };
    }
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

const { PaymentsSection } = (await import("./PaymentsSection.tsx")) as typeof import("./PaymentsSection.tsx");
const { paymentsSpec } = (await import("./view.ts")) as typeof import("./view.ts");
const { receiptsSpec } = (await import("../receipts/view.ts")) as typeof import("../receipts/view.ts");
const { resolveValue } = (await import("@braedonsaunders/appkit-viewspec")) as typeof import("@braedonsaunders/appkit-viewspec");
hooks.deregister();

function authzWith(permissions: string[]): Authz {
  return {
    user: { orgId: "org-1", id: "user-1", roles: [] },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as unknown as Authz;
}

interface RenderedList {
  drawer: { props: Record<string, unknown> } | null;
  emptyAction: unknown;
  canManage: unknown;
}

async function renderSection(
  kind: "vendor_payment" | "customer_payment",
  permissions: string[],
  sp: Record<string, string | string[] | undefined>,
  canCreate: boolean,
): Promise<null | RenderedList> {
  sectionState.listProps = null;
  const authz = authzWith(permissions);
  const el = (await PaymentsSection({
    sp,
    authz,
    basePath: kind === "vendor_payment" ? "/payments" : "/receipts",
    kind,
    orgId: "org-1",
    userId: "user-1",
    canManage: permissions.includes("admin.customization.manage"),
    canCreate,
    userRoles: [],
  })) as { props: { drawer: RenderedList["drawer"]; emptyAction: unknown; canManage: unknown } } | null;
  if (el === null) return null;
  return { drawer: el.props.drawer, emptyAction: el.props.emptyAction, canManage: el.props.canManage };
}

test("an ap.pay-only user with ?paymentNew=1 gets the editable create drawer", async () => {
  const section = (await renderSection("vendor_payment", ["ap.pay"], { paymentNew: "1" }, true))!;
  assert.ok(section, "section renders for a payer");
  assert.equal(section.canManage, false);
  assert.ok(section.drawer, "the create drawer opens without the customization right");
  assert.equal(section.drawer.props.createMode, true);
  assert.equal(section.drawer.props.initialMode, "edit");
  assert.ok(section.emptyAction, "the New payment button is still offered");
});

test("the same payer without ?paymentNew=1 sees New payment and no drawer", async () => {
  const section = (await renderSection("vendor_payment", ["ap.pay"], {}, true))!;
  assert.ok(section);
  assert.equal(section.drawer, null);
  assert.ok(section.emptyAction);
});

test("a user without ap.pay never sees New payment", async () => {
  assert.equal(await renderSection("vendor_payment", ["gl.read"], { paymentNew: "1" }, false), null);
  assert.equal(await renderSection("vendor_payment", ["gl.read"], {}, false), null);
});

test("an ar.pay-only user on receipts with ?paymentNew=1 gets the editable create drawer", async () => {
  const section = (await renderSection("customer_payment", ["ar.pay"], { paymentNew: "1" }, true))!;
  assert.ok(section, "section renders for a receiver");
  assert.equal(section.canManage, false);
  assert.ok(section.drawer, "the create drawer opens without the customization right");
  assert.equal(section.drawer.props.createMode, true);
  assert.ok(section.emptyAction, "the New receipt button is still offered");
});

test("withholding canCreate hides both the button and the drawer", async () => {
  const section = (await renderSection("vendor_payment", ["ap.pay"], { paymentNew: "1" }, false))!;
  assert.ok(section);
  assert.equal(section.drawer, null);
  assert.equal(section.emptyAction, undefined);
});

test("the customization right still reaches the list view untouched", async () => {
  const section = (await renderSection("vendor_payment", ["ap.pay", "admin.customization.manage"], {}, true))!;
  assert.ok(section);
  assert.equal(section.canManage, true);
  assert.ok(section.drawer === null);
});

/** Collect every 'new-payment' header widget ref in a page spec. */
function headerNewPaymentWidgets(spec: unknown): { when: unknown }[] {
  const found: { when: unknown }[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.widget === "new-payment") found.push({ when: record.when });
    for (const value of Object.values(record)) visit(value);
  };
  visit(spec);
  return found;
}

const paymentsBase = {
  title: "t",
  description: "d",
  newPaymentLabel: "New",
  newRunLabel: "Run",
  newRunHref: "/payments?view=runs&newRun=1",
  onPayments: true,
  onRuns: false,
  view: "payments" as const,
  tabLabels: { payments: "P", runs: "R" },
  currentParams: {},
};

test("the payments header button shares canCreate with the drawer", () => {
  const shown = headerNewPaymentWidgets(paymentsSpec({ ...paymentsBase, showNewPayment: true }));
  assert.equal(shown.length, 1);
  assert.equal(resolveValue(shown[0]!.when as never, { ...paymentsBase, showNewPayment: true }), true);
  const hidden = headerNewPaymentWidgets(paymentsSpec({ ...paymentsBase, showNewPayment: false }));
  assert.equal(hidden.length, 1);
  assert.equal(resolveValue(hidden[0]!.when as never, { ...paymentsBase, showNewPayment: false }), false);
});

test("the receipts header button shares canCreate with the drawer", () => {
  const data = {
    title: "t",
    description: "d",
    newReceiptLabel: "New",
    newRunLabel: "Run",
    newRunHref: "/receipts?view=runs&newRun=1",
    onReceipts: true,
    onRuns: false,
    view: "receipts" as const,
    tabLabels: { receipts: "R", collections: "C" },
    currentParams: {},
  };
  const shown = headerNewPaymentWidgets(receiptsSpec({ ...data, showNewReceipt: true }));
  assert.equal(shown.length, 1);
  assert.equal(resolveValue(shown[0]!.when as never, { ...data, showNewReceipt: true }), true);
  const hidden = headerNewPaymentWidgets(receiptsSpec({ ...data, showNewReceipt: false }));
  assert.equal(hidden.length, 1);
  assert.equal(resolveValue(hidden[0]!.when as never, { ...data, showNewReceipt: false }), false);
});
