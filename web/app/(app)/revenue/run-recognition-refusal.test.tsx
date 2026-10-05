import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/revenue",
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

Object.assign(globalThis, { __recognitionToasts: [] as [string, ...unknown[]][] });
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(...a){globalThis.__recognitionToasts.push(['success',...a])},error(...a){globalThis.__recognitionToasts.push(['error',...a])}}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
      };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},replace(){},refresh(){}}};export function useSearchParams(){return new URLSearchParams()};export function usePathname(){return'/revenue'}",
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
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { MoneyProvider } = await import("../../../components/money-provider.tsx");
const { RunRecognitionDrawer } = await import("./RunRecognitionDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type FetchStub = { ok: boolean; status: number; json: () => Promise<unknown>; clone: () => FetchStub };
const stubRes = (body: unknown, status = 422): FetchStub => ({
  ok: false,
  status,
  json: async () => body,
  clone() {
    return stubRes(body, status);
  },
});

const realFetch = globalThis.fetch;
function queueFetch(bodies: FetchStub[]) {
  const queue = [...bodies];
  globalThis.fetch = (async () => {
    const next = queue.shift();
    assert.ok(next, "no unexpected fetch leaves the drawer");
    return next;
  }) as unknown as typeof fetch;
}

async function renderDrawer() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MoneyProvider currency="USD">
          <RunRecognitionDrawer books={[]} periods={[]} candidates={[]} open onClose={() => {}} />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return { host, root };
}

async function unmount(host: Element, root: { unmount(): void }) {
  await act(async () => {
    root.unmount();
  });
  host.remove();
}

function clickButton(_host: Element, label: string): HTMLButtonElement {
  // The drawer portals onto document.body, so buttons live outside the mount host.
  const button = [...document.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes(label),
  );
  assert.ok(button, `the drawer offers ${label}`);
  return button as HTMLButtonElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();
    await tick();
  });
}

function errorBox(_host: Element): string {
  return [...document.querySelectorAll("p")].map((p) => p.textContent ?? "").join("\n");
}

/**
 * An engine refusal the code map does not name must still reach the
 * operator whole: the shared reader carries the server message and its
 * remedy instead of dropping everything but body.error.
 */
test("an unnamed engine refusal surfaces its message and remedy", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  queueFetch([
    stubRes({
      error: "January 2026: GL period closed",
      remedy: "Reopen January 2026 before running recognition.",
    }),
  ]);
  const { host, root } = await renderDrawer();
  try {
    await click(clickButton(host, "Preview"));
    const text = errorBox(host);
    assert.ok(text.includes("GL period closed"), "the server message reaches the drawer");
    assert.ok(text.includes("Reopen January 2026"), "the server remedy reaches the drawer");
  } finally {
    await unmount(host, root);
  }
});

/**
 * Known scope codes keep their localized remedies: a missing book reads
 * as the scope remedy, never the raw code.
 */
test("a known scope code keeps its localized remedy", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  queueFetch([stubRes({ error: "book_not_found", field: "bookId" })]);
  const { host, root } = await renderDrawer();
  try {
    await click(clickButton(host, "Preview"));
    const text = errorBox(host);
    assert.ok(
      text.includes("That scope is no longer available. Reopen the drawer."),
      "the localized scope remedy renders",
    );
    assert.ok(!text.includes("book_not_found"), "the raw code never leaks");
  } finally {
    await unmount(host, root);
  }
});

const previewOk = {
  asOfDate: "2026-09-30",
  obligationId: null,
  contractId: null,
  bookId: null,
  periodId: null,
  rows: [],
  postableCount: 1,
  skippedCount: 0,
  totalAmount: "10.00",
  totalDebits: "10.00",
  totalCredits: "10.00",
  balanced: true,
  projectSyncPending: false,
  warnings: [],
  fingerprint: "fp-1",
};

/**
 * Preview, stale confirm, retry: the 409 names the localized stale remedy,
 * and refreshing the preview clears it so the operator can confirm again.
 */
test("a stale confirm names its remedy and a refresh clears it", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  queueFetch([
    { ok: true, status: 200, json: async () => previewOk, clone() { return this; } } as unknown as FetchStub,
    stubRes({ error: "stale_preview" }, 409),
    { ok: true, status: 200, json: async () => previewOk, clone() { return this; } } as unknown as FetchStub,
  ]);
  const { host, root } = await renderDrawer();
  try {
    await click(clickButton(host, "Preview"));
    await click(clickButton(host, "Confirm and post"));
    assert.ok(
      errorBox(host).includes("The reviewed set changed. Preview again, then confirm."),
      "the stale refusal names its remedy",
    );
    await click(clickButton(host, "Refresh preview"));
    assert.ok(
      !errorBox(host).includes("The reviewed set changed"),
      "a fresh preview clears the refusal",
    );
    assert.ok(clickButton(host, "Confirm and post"), "confirm is offered again after retry");
  } finally {
    await unmount(host, root);
  }
});

/**
 * Confirm readback: a successful run replaces the preview with the posted
 * result — counts, amounts and per-entry journal links.
 */
test("a confirmed run reads back its posted entries", async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  queueFetch([
    { ok: true, status: 200, json: async () => previewOk, clone() { return this; } } as unknown as FetchStub,
    {
      ok: true,
      status: 200,
      json: async () => ({
        posted: 1,
        skipped: 0,
        totalAmount: "10.00",
        entries: [
          {
            contract: "C-1042",
            obligation: "Mobilization",
            period: "Sep 2026",
            amount: "10.00",
            entryId: "entryid12345678",
          },
        ],
        problems: [],
      }),
      clone() {
        return this;
      },
    } as unknown as FetchStub,
  ]);
  const { host, root } = await renderDrawer();
  try {
    await click(clickButton(host, "Preview"));
    await click(clickButton(host, "Confirm and post"));
    const text = document.body.textContent ?? "";
    assert.ok(text.includes("1 entry"), "the posted count reads back");
    assert.ok(text.includes("C-1042"), "the posted contract reads back");
    const entryLink = document.querySelector("a[href*='entryid12345678']");
    assert.ok(entryLink, "the posted entry links to its journal record");
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
    assert.ok(
      !labels.some((label) => label.includes("Confirm and post")),
      "the preview confirm leaves with the result",
    );
  } finally {
    await unmount(host, root);
  }
});
