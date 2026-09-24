import assert from "node:assert/strict";
import test from "node:test";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/query",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
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
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messagesFr = (await import("../../../messages/fr")).default;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { QueryConsole } = await import("./sections");

function renderConsole() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

async function mountConsole(host: Element, root: ReturnType<typeof createRoot>) {
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: "fr",
        messages: messagesFr,
        timeZone: "UTC",
        children: React.createElement(BusinessDateProvider, {
          today: "2026-09-24",
          children: React.createElement(QueryConsole, {}),
        }),
      }),
    );
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

async function unmountConsole(host: Element, root: ReturnType<typeof createRoot>) {
  await act(async () => {
    root.unmount();
  });
  host.remove();
}

// F4T2-8: a schema 500 with an empty body surfaces the named, translated
// refusal — never the browser's JSON SyntaxError and never hardcoded English.
test("F4T2-8: empty schema failure renders the translated refusal", async () => {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/query/schema")) return new Response("", { status: 500 });
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  const { host, root } = renderConsole();
  await mountConsole(host, root);
  try {
    const text = host.textContent ?? "";
    assert.ok(
      text.includes("réponse vide (HTTP 500)"),
      `schema error must be the translated refusal, got ${text.slice(0, 200)}`,
    );
    assert.ok(!text.includes("empty response"), "no hardcoded English may leak");
  } finally {
    await unmountConsole(host, root);
  }
});

// F4T2-8: a schema refusal whose JSON body carries no usable error falls back
// to the translated request-failed message with the status.
test("F4T2-8: nameless schema refusal renders the translated fallback", async () => {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/query/schema")) return new Response("{}", { status: 503 });
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  const { host, root } = renderConsole();
  await mountConsole(host, root);
  try {
    const text = host.textContent ?? "";
    assert.ok(
      text.includes("La requête a échoué (HTTP 503)"),
      `schema error must be the translated fallback, got ${text.slice(0, 200)}`,
    );
    assert.ok(!text.includes("Query request failed"), "no hardcoded English may leak");
  } finally {
    await unmountConsole(host, root);
  }
});

// F4T2-8: a schema 200 with no tables array is an invalid schema response,
// named in the operator locale.
test("F4T2-8: invalid schema shape renders the translated refusal", async () => {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/query/schema")) return Response.json({ tables: {} });
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  const { host, root } = renderConsole();
  await mountConsole(host, root);
  try {
    const text = host.textContent ?? "";
    assert.ok(
      text.includes("schéma invalide"),
      `schema error must be the translated refusal, got ${text.slice(0, 200)}`,
    );
    assert.ok(!text.includes("invalid schema response"), "no hardcoded English may leak");
  } finally {
    await unmountConsole(host, root);
  }
});

// F4T2-8: a run whose 200 body is not a result surfaces the translated
// invalid-result refusal in the results pane.
test("F4T2-8: invalid run result renders the translated refusal", async () => {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("/api/query/schema")) return Response.json({ tables: [] });
    if (String(url).endsWith("/api/query")) {
      return Response.json({ columns: [], rows: "nope", rowCount: 0 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
  const { host, root } = renderConsole();
  await mountConsole(host, root);
  try {
    const run = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Exécuter"),
    );
    assert.ok(run, "the Run button must render");
    await act(async () => {
      run.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const text = host.textContent ?? "";
    assert.ok(
      text.includes("résultat invalide"),
      `run error must be the translated refusal, got ${text.slice(0, 300)}`,
    );
    assert.ok(!text.includes("invalid result"), "no hardcoded English may leak");
  } finally {
    await unmountConsole(host, root);
  }
});
