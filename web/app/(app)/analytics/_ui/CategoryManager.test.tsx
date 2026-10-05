import assert from "node:assert/strict";
import test from "node:test";

// The manual/formula subsidiary attribution must be settable in the UI
// (AGENTS.md 9a: an API-only setting is not configurable) and must survive
// the editor: server value -> draft -> PUT body. The editor only opens on
// click, so this drives the real component in jsdom: GET seeds a manual
// category attributed to Branch, the test toggles HQ on, saves, and asserts
// the PUT body carries both ids with the revision it read.

// jsdom first: the manager reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/banking/cash", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return globalThis.__cmRouter}export function usePathname(){return '/banking/cash'}export function useSearchParams(){return new URLSearchParams()}" });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { CategoryManager } = await import("./CategoryManager");
const { MoneyProvider } = await import("../../../../components/money-provider");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

declare global {
  var __cmRouter: { push(url: string): void; refresh(): void } | undefined;
}

let capturedPut: { categories: { subsidiaryIds?: string[] }[]; expectedRevision: unknown } | undefined;

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
  assert.equal(found.length, 1, `expected exactly one button named ${JSON.stringify(name)}`);
  return found[0]!;
}

const SERVER_CATEGORY = {
  id: "cat-branch-rent",
  name: "Branch rent",
  direction: "outflow",
  method: "manual_recurring",
  amount: "300.0000",
  frequency: "weekly",
  subsidiaryIds: ["s-br"],
};

const SUBSIDIARIES = [
  { id: "s-br", name: "Branch" },
  { id: "s-hq", name: "HQ" },
];

test("subsidiary attribution round-trips through the category editor", async () => {
  globalThis.__cmRouter = { push() {}, refresh() {} };
  capturedPut = undefined as typeof capturedPut;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/analytics/cashflow/categories" && (!init?.method || init.method === "GET")) {
      return Response.json({ categories: [SERVER_CATEGORY], revision: 7 });
    }
    if (url === "/api/analytics/cashflow/categories" && init?.method === "PUT") {
      capturedPut = JSON.parse(String(init.body));
      return Response.json({ ok: true, categories: capturedPut!.categories, revision: 8 });
    }
    return null;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <CategoryManager vendorOptions={[]} accountOptions={[]} subsidiaryOptions={SUBSIDIARIES} initialCategories={[]} />
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    await tick();
    // Server -> UI: the GET list renders.
    assert.ok(host.textContent?.includes("Branch rent"), "the fetched category must render");
    // Open the editor: the attribution field appears for manual_recurring.
    await click(host.querySelector('button[title="Edit"]')!);
    assert.ok(host.textContent?.includes("Subsidiaries"), "manual categories must offer subsidiary attribution");
    // The server-side attribution arrives pre-selected in the draft...
    const branchOption = buttonNamed("Branch");
    assert.equal(branchOption.querySelector("input")?.checked, true, "the attributed subsidiary must start selected");
    // ...toggling HQ on and saving sends both ids with the read revision.
    await click(buttonNamed("HQ"));
    await click(buttonNamed("Save category"));
    assert.deepEqual(
      capturedPut?.categories[0]?.subsidiaryIds,
      ["s-br", "s-hq"],
      "the PUT body must carry the kept attribution plus the toggled one",
    );
    assert.equal(capturedPut?.expectedRevision, 7, "the save must carry the revision it read");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  }
});

test("a new draft names its frequency explicitly instead of showing one and saving another", async () => {
  // The select shows Weekly for an unset frequency while the engine used to
  // assume monthly: a new draft must carry the displayed cadence, so what
  // the operator sees is what the save persists.
  globalThis.__cmRouter = { push() {}, refresh() {} };
  capturedPut = undefined as typeof capturedPut;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/analytics/cashflow/categories" && (!init?.method || init.method === "GET")) {
      return Response.json({ categories: [], revision: 3 });
    }
    if (url === "/api/analytics/cashflow/categories" && init?.method === "PUT") {
      capturedPut = JSON.parse(String(init.body));
      return Response.json({ ok: true, categories: capturedPut!.categories, revision: 4 });
    }
    return null;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const setNativeValue = (el: HTMLInputElement | HTMLSelectElement, value: string, event: string) => {
    const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <CategoryManager vendorOptions={[]} accountOptions={[]} subsidiaryOptions={[]} initialCategories={[]} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    await click(buttonNamed("New category"));
    const nameInput = host.querySelector('input[placeholder="Category name"]') as HTMLInputElement;
    assert.ok(nameInput, "the new draft must offer a name field");
    await act(async () => {
      setNativeValue(nameInput, "Weekly cleaner", "input");
      await tick();
    });
    const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
    // Direction, then method: switching to manual_recurring reveals amount.
    assert.ok(selects.length >= 2, "the draft must offer direction and method selects");
    await act(async () => {
      setNativeValue(selects[1]!, "manual_recurring", "change");
      await tick();
    });
    const amountInput = host.querySelector('input[type="number"]') as HTMLInputElement;
    assert.ok(amountInput, "a manual draft must offer an amount field");
    await act(async () => {
      setNativeValue(amountInput, "200", "input");
      await tick();
    });
    await click(buttonNamed("Add category"));
    assert.equal(capturedPut?.categories[0]?.method, "manual_recurring");
    assert.equal(
      capturedPut?.categories[0]?.frequency,
      "weekly",
      "the saved draft must carry the cadence the select displayed",
    );
    assert.equal(capturedPut?.expectedRevision, 3, "the save must carry the revision it read");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  }
});

test("no subsidiary UI without visible subsidiaries", async () => {
  globalThis.__cmRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/analytics/cashflow/categories" && (!init?.method || init.method === "GET")) {
      return Response.json({ categories: [SERVER_CATEGORY], revision: 7 });
    }
    return null;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <CategoryManager vendorOptions={[]} accountOptions={[]} subsidiaryOptions={[]} initialCategories={[]} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      );
      await tick();
    });
    await tick();
    await tick();
    await click(host.querySelector('button[title="Edit"]')!);
    assert.ok(!host.textContent?.includes("Subsidiaries"), "single-subsidiary orgs must not see the attribution field");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    restoreFetch();
  }
});
