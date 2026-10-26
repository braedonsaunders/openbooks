import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";
import type { SubscriptionDrawerData } from "./subscription-drawer";

await bootJsdomEnvironment({ url: "http://localhost/collections", matchMediaMatches: false });
stubModules({ navigation: {} });
const state = {
  promptValue: null as string | null,
  prompts: [] as Record<string, unknown>[],
  posts: [] as Record<string, unknown>[],
  changed: 0,
  refuse: false,
};
Object.assign(globalThis, { __subscriptionActionTest: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/prompt")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(options){globalThis.__subscriptionActionTest.prompts.push(options);return globalThis.__subscriptionActionTest.promptValue}",
      };
    return next(specifier, context);
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { useSubscriptionLifecycle } = await import("./use-subscription-lifecycle");
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function Harness({ drawer }: { drawer: SubscriptionDrawerData }) {
  const lifecycle = useSubscriptionLifecycle(drawer, async () => {
    state.changed++;
  });
  return (
    <>
      {lifecycle.actions}
      {lifecycle.refusal ? <p role="alert">{lifecycle.refusal}</p> : null}
      {lifecycle.panel}
    </>
  );
}
async function mount(t: TestContext, overrides: Partial<SubscriptionDrawerData> = {}) {
  Object.assign(state, { promptValue: null, prompts: [], posts: [], changed: 0, refuse: false });
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") {
      state.posts.push(JSON.parse(String(init.body)));
      return state.refuse
        ? Response.json({ error: "The billing period is closed." }, { status: 422 })
        : Response.json({});
    }
    return Response.json({
      periods: ["2026-08-01", "2026-09-01"],
      estimatedTotal: "200.0000",
      currency: "CAD",
    });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const drawer = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "active",
    canManage: true,
    quantity: "1",
    currency: "CAD",
    paidThroughOn: "2026-10-01",
    advancedLifecycle: false,
    ...overrides,
  } as SubscriptionDrawerData;
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <BusinessDateProvider today="2026-10-21">
            <Harness drawer={drawer} />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    ),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = prior;
  });
  return async (name: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === name,
    );
    assert.ok(button, name);
    await act(async () => {
      button.click();
      await tick();
    });
  };
}

test("subscription controls require manage permission", async (t) => {
  await mount(t, { canManage: false });
  assert.equal(document.querySelectorAll("button").length, 0);
});
test("pause uses the native command and a refusal preserves the drawer action", async (t) => {
  const click = await mount(t);
  state.refuse = true;
  await click("Pause");
  assert.equal(state.changed, 0);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /billing period is closed/,
  );
  state.refuse = false;
  await click("Pause");
  assert.deepEqual(state.posts[1], {
    action: "updateSubscription",
    status: "paused",
    id: "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(state.changed, 1);
});
test("resume waits for an explicit catch-up choice before writing", async (t) => {
  const click = await mount(t, { status: "paused" });
  await click("Resume");
  assert.equal(state.posts.length, 0);
  const choices = messages.ar.collections.subscriptions;
  await click(choices.catchUpSelectedDrafts);
  assert.deepEqual(state.posts[0]?.catchUp, {
    mode: "selected",
    post: false,
    dates: ["2026-08-01", "2026-09-01"],
  });
  assert.equal(state.changed, 1);
});
test("cancellation starts at the native paid-through boundary and preserves the selected date", async (t) => {
  const click = await mount(t);
  state.promptValue = "2026-10-01";
  await click(messages.ar.collections.subscriptions.cancelSub);
  assert.equal(state.prompts[0]?.initialValue, "2026-10-01");
  assert.deepEqual(state.posts[0], {
    action: "updateSubscription",
    status: "canceled",
    canceledOn: "2026-10-01",
    id: "00000000-0000-4000-8000-000000000001",
  });
});

test("the native drawer retains its reread record when the list rerenders its original selection", async (t) => {
  const { SubscriptionDrawer } = await import("./SubscriptionDrawer");
  const seed: SubscriptionDrawerData = {
    id: "00000000-0000-4000-8000-000000000001",
    remountKey: "subscription-1",
    planName: "Monthly service",
    customer: { id: "customer-1", name: "Customer" },
    status: "active",
    startOn: "2026-01-01",
    nextBillOn: "2026-11-01",
    interval: "monthly",
    intervalCount: 1,
    quantity: "1",
    amount: "100.0000",
    currency: "CAD",
    autoPost: false,
    paidThroughOn: "2026-11-01",
    advancedLifecycle: false,
    billTo: null,
    payer: null,
    lastInvoice: null,
    contract: null,
    lastError: null,
    canManage: true,
    closeHref: "/collections",
    customers: [],
  };
  const prior = globalThis.fetch;
  let posted = false;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") {
      posted = true;
      return Response.json({});
    }
    return Response.json({
      widget: "subscription-drawer",
      drawer: { ...seed, status: posted ? "paused" : "active" },
    });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    globalThis.fetch = prior;
  });
  const render = async () => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="CAD">
            <BusinessDateProvider today="2026-10-21">
              <SubscriptionDrawer drawer={{ ...seed }} closeHref="/collections" />
            </BusinessDateProvider>
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
  };
  await render();
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.ok(dialog);
  for (const name of ["Actions", "Pause"]) {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === name,
    );
    assert.ok(button, name);
    await act(async () => {
      button.click();
      await tick();
    });
  }
  assert.ok(posted);
  await render();
  assert.equal(
    document.querySelector('[role="dialog"]'),
    dialog,
    "the selected record keeps one drawer shell",
  );
  assert.match(dialog.textContent ?? "", /Paused/);
  assert.doesNotMatch(dialog.textContent ?? "", /Status: Active/);
});
