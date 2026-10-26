import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../testing/jsdom-env";
import { stubModules } from "../../testing/stub-modules";

/**
 * Register client surfaces against the real catalogs and the real drawer
 * shell; only the network and the router are scripted. The session report
 * keeps one dialog through loading, a refusal with its remedy, retry and
 * success, and closes back to the list's own filters. The register screen
 * shows the open-drawer step only to a user who may open it, and the
 * selling surface once a session is open.
 */

await bootJsdomEnvironment({
  url: "http://localhost/pos/sessions?status=closed",
  matchMediaMatches: true,
});
const React = await import("react");
Object.assign(globalThis, { React, __posReact: React, IS_REACT_ACT_ENVIRONMENT: true });
const subscribers = new Set<() => void>();
Object.assign(globalThis, {
  __posSubscribe: (fn: () => void) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
});
const push = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => {
  push(...args);
  for (const fn of subscribers) fn();
};
const replace = window.history.replaceState.bind(window.history);
window.history.replaceState = (...args) => {
  replace(...args);
  for (const fn of subscribers) fn();
};
window.addEventListener("popstate", () => {
  for (const fn of subscribers) fn();
});
stubModules({
  navigation: {
    source: `
  export function usePathname(){return window.location.pathname}
  export function useSearchParams(){const q=globalThis.__posReact.useSyncExternalStore(globalThis.__posSubscribe,()=>window.location.search);return new URLSearchParams(q)}
  export function useRouter(){return {push(){},refresh(){},replace(){},back(){},forward(){}}}
`,
  },
});
const { createRoot } = await import("react-dom/client");
const { act } = React;
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../messages/en")).default;
const { MoneyProvider } = await import("../money-provider");
const { PosSessionHost, SessionOpenLink } = await import("./session-history");
const { RegisterScreen } = await import("./register-screen");

const SESSION = "019f0000-0000-4000-8000-0000000000d1";
const REGISTER = "019f0000-0000-4000-8000-0000000000c1";
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const summary = {
  session: {
    id: SESSION,
    registerId: REGISTER,
    sessionNumber: 7,
    status: "closed",
    businessDate: "2026-10-16",
    currency: "CAD",
    openingFloatMinor: "2000000",
    openedAt: "2026-10-16 08:00:00+00",
    closedAt: "2026-10-16 17:00:00+00",
    expectedCashMinor: "5000000",
    countedCashMinor: "4990000",
    overShortMinor: "-10000",
    closeNote: null,
    overShortEntryId: null,
  },
  register: { id: REGISTER, code: "R1", name: "Front counter" },
  saleCount: 12,
  refundCount: 1,
  salesTotalMinor: "3000000",
  refundsTotalMinor: "50000",
  tenders: [{ kind: "cash", methodLabel: "Cash", saleMinor: "3000000", refundMinor: "50000" }],
  payInMinor: "0",
  payOutMinor: "0",
  saleCashMinor: "3000000",
  refundCashMinor: "50000",
  expectedCashMinor: "5000000",
  movements: [],
};

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: () =>
      act(async () => {
        root.render(
          <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
            <MoneyProvider currency="CAD">{node}</MoneyProvider>
          </NextIntlClientProvider>,
        );
      }),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a session report keeps one drawer through refusal, retry and success, and closes to the list filters", async (t) => {
  const priorFetch = globalThis.fetch;
  const calls: string[] = [];
  let respond: () => Response = () =>
    Response.json(
      {
        error: "That register session is not in your legal entities.",
        remedy: "Ask an administrator for access to its legal entity.",
        code: "session_not_found",
      },
      { status: 404 },
    );
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const view = mount(
    <>
      <SessionOpenLink sessionId={SESSION}>Session 7</SessionOpenLink>
      <PosSessionHost />
    </>,
  );
  t.after(view.unmount);
  await view.render();
  assert.equal(
    document.querySelector('[role="dialog"]'),
    null,
    "no drawer until a session is selected",
  );

  await act(async () => {
    (view.container.querySelector("a") as HTMLAnchorElement).click();
    await tick();
  });
  assert.equal(window.location.search, `?status=closed&session=${SESSION}`);
  assert.deepEqual(calls, [`/api/pos/sessions/${SESSION}`]);
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.ok(
    dialog.textContent?.includes(
      "That register session is not in your legal entities. Ask an administrator for access to its legal entity.",
    ),
  );

  respond = () => Response.json({ summary });
  const retry = [...dialog.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  );
  assert.ok(retry, "a refusal offers retry");
  await act(async () => {
    retry.click();
    await tick();
  });
  assert.ok(document.querySelector('[role="dialog"]') === dialog, "retry keeps the same dialog");
  assert.ok(dialog.textContent?.includes("Z report · session 7"));
  assert.ok(dialog.textContent?.includes("Short"), "a negative over/short reads as short");
  assert.ok(dialog.textContent?.includes("R1 · Front counter"));

  const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
  await act(async () => {
    close.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  assert.equal(window.location.search, "?status=closed");
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

const context = (session: unknown) => ({
  register: {
    id: REGISTER,
    code: "R1",
    name: "Front counter",
    currency: "CAD",
    currencyDecimals: 2,
    denominations: [],
    receiptHeader: null,
    receiptFooter: null,
    defaultCustomerId: null,
  },
  acceptedTenders: ["cash"],
  session,
  quickKeys: [{ itemId: "019f0000-0000-4000-8000-0000000000f1", label: "Coffee", code: "COF" }],
  cashReasons: [],
  defaultCustomerName: null,
});

test("a closed register asks a drawer user to count the float and tells a cashier who can open it", async (t) => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json(context(null))) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const cashier = mount(
    <RegisterScreen
      registerId={REGISTER}
      canRefund={false}
      canOverride={false}
      canManageDrawer={false}
      canViewSessions={false}
    />,
  );
  await cashier.render();
  await act(tick);
  assert.ok(
    cashier.container.textContent?.includes(
      "The drawer is closed. Ask a user who can open the drawer",
    ),
  );
  assert.ok(!cashier.container.textContent?.includes("Open the drawer"));
  await cashier.unmount();

  const supervisor = mount(
    <RegisterScreen registerId={REGISTER} canRefund canOverride canManageDrawer canViewSessions />,
  );
  t.after(supervisor.unmount);
  await supervisor.render();
  await act(tick);
  assert.ok(supervisor.container.textContent?.includes("Open the drawer"));
  assert.ok(
    supervisor.container.querySelector("#count-total"),
    "a register without denominations counts one total",
  );
});

test("an open register sells: quick keys, the scan field, and only the actions the cashier holds", async (t) => {
  const priorFetch = globalThis.fetch;
  const open = {
    id: "019f0000-0000-4000-8000-0000000000d2",
    registerId: REGISTER,
    sessionNumber: 8,
    status: "open",
    businessDate: "2026-10-17",
    currency: "CAD",
    openingFloatMinor: "2000000",
    openedAt: "2026-10-17 08:00:00+00",
    closedAt: null,
    expectedCashMinor: null,
    countedCashMinor: null,
    overShortMinor: null,
  };
  globalThis.fetch = (async () => Response.json(context(open))) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const cashier = mount(
    <RegisterScreen
      registerId={REGISTER}
      canRefund={false}
      canOverride={false}
      canManageDrawer={false}
      canViewSessions={false}
    />,
  );
  t.after(cashier.unmount);
  await cashier.render();
  await act(tick);
  const text = cashier.container.textContent ?? "";
  assert.ok(text.includes("Session 8 · 2026-10-17"));
  assert.ok(text.includes("Coffee"));
  assert.ok(cashier.container.querySelector('input[aria-label="Scan or search items"]'));
  const buttons = [...cashier.container.querySelectorAll("button")].map(
    (button) => button.textContent,
  );
  assert.ok(buttons.includes("Held sales"));
  assert.ok(!buttons.includes("Refund"), "refunds need the refund permission");
  assert.ok(!buttons.includes("Drawer"), "drawer handling needs the drawer permission");
  assert.ok(!buttons.includes("Sale discount"), "discounts need the override permission");
});
