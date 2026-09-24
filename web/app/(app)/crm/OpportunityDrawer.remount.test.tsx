import assert from "node:assert/strict";
import test from "node:test";

// Switching from one open opportunity to another must not pour B's props
// into A's stateful form: the title field (and every other useState seeded
// from props) has to show the newly opened record. The drawer mounts through
// the `opportunity-drawer` widget, so the test drives that widget —
// rendering the component directly would bypass the wiring under test.

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
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default {};",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
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
const { RECORDS_WIDGETS } = await import("../../../components/viewspec/widgets-records");
const { OPERATIONS_WIDGETS } = await import("../../../components/viewspec/widgets-operations");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function opportunityDrawerProps(id: string, title: string) {
  return {
    data: {
      opportunity: {
        id,
        title,
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
        opportunity_number: `OPP-${id}`,
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

function titleInput(): string | null {
  // UrlDrawer portals to document.body, so the form lives outside the mount host.
  const inputs = [...document.querySelectorAll("input")];
  // The title field is the first free-text input in the drawer form.
  const first = inputs.find((el) => el.getAttribute("type") !== "number" && el.getAttribute("type") !== "date");
  return first ? (first as HTMLInputElement).value : null;
}

test("opening a second opportunity resets the drawer form to the new record", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const renderDrawer = (element: React.ReactNode) =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">{element}</BusinessDateProvider>
      </NextIntlClientProvider>,
    );
  const renderer = RECORDS_WIDGETS["opportunity-drawer"] as (props: Record<string, unknown>) => React.ReactNode;
  await act(async () => {
    renderDrawer(renderer({ drawer: { remountKey: "aaa", ...opportunityDrawerProps("aaa", "Alpha") } }));
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.equal(titleInput(), "Alpha");
  // Same slot, different record — exactly what the page renders when the
  // `opportunity` search param changes without a full navigation.
  await act(async () => {
    renderDrawer(renderer({ drawer: { remountKey: "bbb", ...opportunityDrawerProps("bbb", "Beta") } }));
    await tick();
  });
  await tick();
  assert.equal(
    titleInput(),
    "Beta",
    "the drawer kept Alpha's form state after switching to Beta — key it by record id",
  );
});

test("every record drawer keys its element by the open record id", () => {
  // Creating the element runs the widget adapter but mounts nothing: the key
  // is what tells React to remount (rather than update) on a record switch,
  // and the mount test above proves a changed key resets the form.
  type Renderer = (props: Record<string, unknown>) => { key: unknown };
  const cases: [string, Renderer, Record<string, unknown>][] = [
    ["activity-drawer", RECORDS_WIDGETS["activity-drawer"] as Renderer, { remountKey: "act-1" }],
    ["opportunity-drawer", RECORDS_WIDGETS["opportunity-drawer"] as Renderer, { remountKey: "opp-1" }],
    [
      "vendor-compliance-drawer",
      (OPERATIONS_WIDGETS as Record<string, Renderer>)["vendor-compliance-drawer"]!,
      { remountKey: "vendor-1" },
    ],
    [
      "lien-waiver-drawer",
      (OPERATIONS_WIDGETS as Record<string, Renderer>)["lien-waiver-drawer"]!,
      { remountKey: "waiver-1" },
    ],
  ];
  for (const [name, renderer, drawer] of cases) {
    const element = renderer({ drawer });
    assert.equal(
      element?.key,
      (drawer as { remountKey: string }).remountKey,
      `${name} must key its drawer by the open record id`,
    );
  }
});
