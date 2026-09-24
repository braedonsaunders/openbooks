import assert from "node:assert/strict";
import test from "node:test";

// Read-only users saw an editable description, quantity and unit price on
// every opportunity line while unit cost stayed locked: the three editable
// cells wrote local state the save could persist. All line inputs now lock
// together behind canManage.

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/crm/opportunities?view=list",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){},prefetch(){},back(){},forward(){}}}export function usePathname(){return '/crm/opportunities'}export function useSearchParams(){return new URLSearchParams()}export function redirect(){throw new Error('redirect')}export function notFound(){throw new Error('not-found')}export function permanentRedirect(){throw new Error('redirect')}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
      };
    }
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default {};",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { OpportunityDrawer } = await import("./OpportunityDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function drawerProps(canManage: boolean) {
  return {
    data: {
      opportunity: {
        id: "opp-1",
        title: "Big deal",
        party_id: null,
        primary_contact_id: null,
        owner_user_id: null,
        sales_team_id: null,
        status_id: "st-open",
        lead_source_id: null,
        expected_close_date: null,
        forecast_category: "pipeline",
        probability: 50,
        currency: "USD",
        next_step: null,
        description: null,
        win_loss_reason: null,
        opportunity_number: "OPP-1",
        status_name: "Open",
        updated_at: "2026-09-17T12:00:00.000Z",
      },
      lines: [
        {
          item_id: null,
          description: "Line work",
          quantity: "2",
          unit: "each",
          unit_price: "10.5",
          unit_cost: "4",
        },
      ],
    },
    statuses: [{ id: "st-open", name: "Open" }],
    accounts: [],
    contacts: [],
    owners: [],
    teams: [],
    sources: [],
    items: [],
    currencies: [],
    closeHref: "/crm/opportunities",
    canManage,
  };
}

async function renderDrawer(canManage: boolean, host: HTMLElement) {
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityDrawer {...drawerProps(canManage)} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return root;
}

function lineInput(value: string): HTMLInputElement | undefined {
  return [...document.querySelectorAll("input")].find((el) => (el as HTMLInputElement).value === value) as
    | HTMLInputElement
    | undefined;
}

test("read-only line cells are disabled; managers keep all four editable", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = await renderDrawer(false, host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  for (const value of ["Line work", "2", "10.5", "4"]) {
    const input = lineInput(value);
    assert.ok(input, `line input ${JSON.stringify(value)} must render`);
    assert.equal(input.disabled, true, `line input ${JSON.stringify(value)} must lock for read-only users`);
  }
});

test("managers can still edit every line cell", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = await renderDrawer(true, host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  for (const value of ["Line work", "2", "10.5", "4"]) {
    const input = lineInput(value);
    assert.ok(input, `line input ${JSON.stringify(value)} must render`);
    assert.equal(input.disabled, false, `line input ${JSON.stringify(value)} must stay editable for managers`);
  }
});
