import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";

// A loaded conflict must stay reachable from its location row even when the
// inventory push-state list carries no row for that identity (an unlinked
// variant leaves the conflict queued with zero state rows). Reachability
// keys on the loaded conflicts, never the narrower state counts — and the
// review drawer opens only the selected identity's conflicts.

// jsdom first: the tab reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/channels/c1", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__locationsRouter}" +
      "export function usePathname(){return '/channels/c1'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__locationsToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__locationsToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__locationsToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
  },
});

const { registerHooks: registerConfirmHooks } = await import("node:module");
registerConfirmHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return 'test reason'}",
      };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    return next(specifier, context);
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { LocationsTab } = await import("./LocationsTab");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";

const LOCATIONS = [
  {
    id: "l1",
    channelId: CHANNEL_ID,
    externalLocationId: "ext-1",
    externalName: "Warehouse East",
    stockLocationId: "s1",
    syncInventory: true,
    fulfilsOrders: true,
    bufferQuantity: "0.0000",
    stopSellingAtZero: true,
  },
];

// Zero push-state rows: the s1 identity has no inventory state, yet its
// loaded conflict must still offer review from the row.
const INVENTORY = {
  states: [],
  conflicts: [
    {
      id: "c1",
      channelId: CHANNEL_ID,
      channelName: "Shop",
      stockLocationId: "s1",
      stockLocationCode: "WH-E",
      externalName: "Warehouse East",
      itemId: "i1",
      itemCode: "SKU-1",
      itemName: "Widget One",
      openbooksQuantity: 5,
      shopifyQuantity: 3,
      createdAt: "2026-09-01T00:00:00.000000Z",
    },
    {
      id: "c2",
      channelId: CHANNEL_ID,
      channelName: "Shop",
      stockLocationId: "s2",
      stockLocationCode: "WH-W",
      externalName: "Warehouse West",
      itemId: "i9",
      itemCode: "SKU-9",
      itemName: "Widget Nine",
      openbooksQuantity: 2,
      shopifyQuantity: 7,
      createdAt: "2026-09-01T00:00:00.000000Z",
    },
  ],
  policies: [],
};

function scriptFetch() {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === `/api/channels/${CHANNEL_ID}/locations` && (!init?.method || init.method === "GET")) {
      return Response.json({ locations: LOCATIONS });
    }
    if (url === `/api/channels/${CHANNEL_ID}/inventory` && (!init?.method || init.method === "GET")) {
      return Response.json(INVENTORY);
    }
    if (url === `/api/channels/${CHANNEL_ID}/stock-locations`) {
      return Response.json({ options: [{ value: "s1", label: "WH-E" }] });
    }
    if (url === "/api/forms/options?source=reference&table=items") {
      return Response.json({ options: [] });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function renderTab() {
  globalThis.__locationsRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LocationsTab channelId={CHANNEL_ID} canManage />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

declare global {
  var __locationsRouter: { push(url: string): void; refresh(): void } | undefined;
  var __locationsToasts: { kind: string; message: string }[] | undefined;
}

test("a conflict with no push-state row still offers review and opens only its identity", async (t) => {
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  const { unmount } = await renderTab();
  t.after(unmount);

  // The queue banner counts both loaded conflicts while states stay empty.
  assert.match(document.body.textContent ?? "", /2 stock conflicts need a decision/);
  // The s1 row offers review for its one conflict despite zero state rows.
  const review = buttonsNamed("1 conflict");
  assert.equal(review.length, 1);
  const reviewButton = review[0];
  assert.ok(reviewButton);

  await click(reviewButton);

  // The drawer opens for the selected identity only: s1's item shows, the
  // s2 conflict never enters this drawer.
  assert.match(document.body.textContent ?? "", /1 stock conflict needs a decision/);
  assert.match(document.body.textContent ?? "", /SKU-1/);
  assert.doesNotMatch(document.body.textContent ?? "", /SKU-9/);
});
