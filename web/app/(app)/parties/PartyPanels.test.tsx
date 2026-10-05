import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the panels read browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties/test-party",
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { PartyPaymentMethodsPanel } = await import("./PartyPaymentMethodsPanel");
const { PartyAutopayPanel } = await import("./PartyAutopayPanel");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function stubFetch(calls: string[]) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/autopay/methods")) return Response.json({ methods: [] });
    if (url.includes("/api/autopay/enrollments")) return Response.json({ enrollments: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = priorFetch;
  };
}

async function mount(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        {node}
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return {
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/**
 * The methods sub-tab owns stored methods only: it must load the methods
 * endpoint and never the enrollments endpoint, and must not render the
 * autopay enrollment copy that used to sit below the methods.
 */
test("the methods panel loads methods without touching enrollments", async (t) => {
  const calls: string[] = [];
  const restore = stubFetch(calls);
  t.after(restore);
  const mounted = await mount(
    <PartyPaymentMethodsPanel partyId="party-1" canManageMethods defaultCurrency="USD" />,
  );
  t.after(() => mounted.cleanup());

  assert.ok(
    calls.some((url) => url.includes("/api/autopay/methods")),
    "the methods panel must load stored methods",
  );
  assert.ok(
    !calls.some((url) => url.includes("/api/autopay/enrollments")),
    "the methods panel must not load autopay enrollments",
  );
  assert.match(
    document.body.textContent ?? "",
    /Payment methods/,
    "the methods panel keeps its own heading",
  );
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /Autopay/,
    "the methods panel must not render enrollment copy",
  );
});

/**
 * The autopay sub-tab owns enrollments only: it must load the enrollments
 * endpoint and never the methods endpoint.
 */
test("the autopay panel loads enrollments without touching methods", async (t) => {
  const calls: string[] = [];
  const restore = stubFetch(calls);
  t.after(restore);
  const mounted = await mount(
    <PartyAutopayPanel partyId="party-1" canManageAutopay />,
  );
  t.after(() => mounted.cleanup());

  assert.ok(
    calls.some((url) => url.includes("/api/autopay/enrollments")),
    "the autopay panel must load enrollments",
  );
  assert.ok(
    !calls.some((url) => url.includes("/api/autopay/methods")),
    "the autopay panel must not load stored methods",
  );
  assert.match(
    document.body.textContent ?? "",
    /Autopay/,
    "the autopay panel keeps the enrollment heading",
  );
});
