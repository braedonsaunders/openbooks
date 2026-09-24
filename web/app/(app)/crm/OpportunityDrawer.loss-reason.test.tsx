import assert from "node:assert/strict";
import test from "node:test";

// The drawer must highlight the win/loss-reason field off the server's
// refusal CODE, never by matching English words in the message: a reworded
// (or translated) refusal still names the same gate, and the highlight is
// the only thing pointing the operator at the field they must fill.

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

function drawerProps() {
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
      lines: [],
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
    canManage: true,
  };
}

test("a reworded loss refusal still highlights the reason field by code", async (t) => {
  // The message carries no English "loss reason" wording on purpose: matching
  // the code is what is under test, not matching the words.
  const refusal = { error: "ein Abschlussgrund ist anzugeben", code: "win_loss_reason_required" };
  const realFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () =>
    new Response(JSON.stringify(refusal), { status: 422, headers: { "content-type": "application/json" } });
  t.after(() => {
    (globalThis as Record<string, unknown>).fetch = realFetch;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <OpportunityDrawer {...drawerProps()} />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const save = [...document.querySelectorAll("button")].find((el) => el.textContent === "Save");
  assert.ok(save, "the drawer must render its Save button");
  await act(async () => {
    (save as HTMLButtonElement).click();
    await tick();
    await tick();
  });
  await tick();
  assert.ok(
    document.body.textContent?.includes("A loss reason is required to close as lost"),
    "the win/loss-reason hint must appear for a coded loss refusal even when the message is reworded",
  );
});
