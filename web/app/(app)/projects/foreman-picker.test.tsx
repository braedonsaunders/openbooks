import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __foremanPickerRouter: { pushes: string[]; replaces: string[]; refreshes: number } | undefined;
}

// The foreman picker offers the same internal people as the manager
// picker — never customers, vendors, or companies — so a choice here
// always survives the write path's shared predicate.
await bootJsdomEnvironment({ url: "http://localhost:4800/projects?projectNew=1", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(u){globalThis.__foremanPickerRouter.pushes.push(String(u))},replace(u){globalThis.__foremanPickerRouter.replaces.push(String(u))},refresh(){globalThis.__foremanPickerRouter.refreshes+=1}}}" +
      "export function usePathname(){return '/projects'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { ProjectDrawer } = await import("./ProjectDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const PAYLOAD = {
  project: {
    id: "",
    code: null,
    name: "",
    is_active: true,
    custom: {},
    customer_id: null,
    foreman_id: null,
    manager_id: null,
    status: "active",
    customer_po_number: null,
    starts_on: null,
    ends_on: null,
    notes: null,
    subsidiary_id: null,
    subsidiary_include_children: true,
    project_type_id: null,
    invoicing_preference: null,
  },
  contractValue: null,
  customerName: null,
  foremanName: null,
  managerName: null,
  tasks: [],
  customFieldDefs: [],
};

const PERMISSIONS = { canRead: false, canCreate: false, canApprove: false, canInvoice: false };

test("the foreman picker lists internal people, not customers or vendors", async (t) => {
  globalThis.__foremanPickerRouter = { pushes: [], replaces: [], refreshes: 0 };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <ProjectDrawer
            payload={PAYLOAD as never}
            parties={[
              { id: "customer-1", display_name: "Acme Customer" },
              { id: "vendor-1", display_name: "Vera Vendor" },
            ]}
            managerParties={[{ id: "staff-1", display_name: "Sam Staff" }]}
            foremanParties={[{ id: "staff-1", display_name: "Sam Staff" }]}
            subsidiaries={[]}
            canManage
            canViewGl={false}
            applicationPermissions={PERMISSIONS}
            cockpit={null}
            projectTypes={[]}
            locale="en"
            createMode
            closeHref="/projects"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await tick();
  const trigger = document.querySelector('button[aria-label="Foreman"]');
  assert.ok(trigger, "the foreman picker renders");
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");
  assert.ok(options.some((label) => label.includes("Sam Staff")), `staff are offered (${JSON.stringify(options)})`);
  assert.ok(!options.some((label) => label.includes("Acme Customer")), "customers are not offered as foreman");
  assert.ok(!options.some((label) => label.includes("Vera Vendor")), "vendors are not offered as foreman");
});
