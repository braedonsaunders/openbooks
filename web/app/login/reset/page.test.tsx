import assert from "node:assert/strict";
import test from "node:test";

// The reset request form must never claim the link is on its way when the
// request itself failed. The fleet probed POST /api/password-reset without a
// browser Origin header and hit the edge CSRF gate's 403 while the page
// reported success. Anti-enumeration stays (a reached server always answers
// 200), so only a failed request may surface an error — proved here through
// the real ResetPage with a scripted fetch, not page source text.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/login/reset",
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
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof window.requestAnimationFrame !== "function") {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((_id: number) => setTimeout(() => {}, 0)) as unknown as typeof window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},replace(){},refresh(){}}}export function usePathname(){return '/login/reset'}export function useSearchParams(){return new URLSearchParams()}",
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
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const ResetPage = (await import("./page.tsx")).default;

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// Distinctive catalog copy, read as rendered text — never the code's own
// string. web/messages/en/login.json is the independent source.
const FAILURE_COPY = "could not be requested";
const SENT_COPY = "reset link is on its way";

type FetchScript = { calls: { url: string; method: string; body: string }[]; respond: () => Promise<Response> };

async function mount(script: FetchScript): Promise<() => Promise<void>> {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    script.calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    return script.respond();
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ResetPage />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick(60);
  return async () => {
    globalThis.fetch = prior;
    await act(async () => {
      root.unmount();
    });
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  };
}

async function submitRequest(email: string): Promise<void> {
  const input = document.querySelector('input[type="email"]') as HTMLInputElement | null;
  assert.ok(input, "the request form offers an email field");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, email);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  assert.ok(submit, "the request form offers a submit button");
  await act(async () => {
    submit.click();
    await tick(60);
  });
  await tick(60);
}

function alertText(): string | null {
  return document.querySelector('p[role="alert"]')?.textContent ?? null;
}

function bodyText(): string {
  return document.body.textContent ?? "";
}

test("a 403 from the origin gate surfaces the failure alert and never claims the link is on its way", async () => {
  const script: FetchScript = {
    calls: [],
    respond: async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
  };
  const cleanup = await mount(script);
  try {
    await submitRequest("operator@example.com");
    assert.equal(script.calls.length, 1, "the form posts exactly one reset request");
    const [call] = script.calls;
    assert.ok(call, "the single reset request was recorded");
    assert.equal(call.url, "/api/password-reset", "the request targets the reset route");
    assert.equal(call.method, "POST", "the request is a POST");
    assert.ok(
      (JSON.parse(call.body) as { email?: string }).email === "operator@example.com",
      "the request carries the typed address",
    );
    const alert = alertText();
    assert.ok(alert?.includes(FAILURE_COPY), `the gate failure renders the failure copy (saw: ${alert})`);
    assert.ok(!bodyText().includes(SENT_COPY), "the sent copy must not render when the request failed");
  } finally {
    await cleanup();
  }
});

test("a 200 shows the sent copy with no alert", async () => {
  const script: FetchScript = {
    calls: [],
    respond: async () => Response.json({ ok: true }),
  };
  const cleanup = await mount(script);
  try {
    await submitRequest("operator@example.com");
    assert.ok(bodyText().includes(SENT_COPY), "a reached server still answers with the sent copy");
    assert.equal(alertText(), null, "no alert renders on success");
  } finally {
    await cleanup();
  }
});

test("a rejected request surfaces the failure alert instead of claiming success", async () => {
  const script: FetchScript = {
    calls: [],
    respond: async () => {
      throw new Error("network down");
    },
  };
  const cleanup = await mount(script);
  try {
    await submitRequest("operator@example.com");
    const alert = alertText();
    assert.ok(alert?.includes(FAILURE_COPY), `a dropped request renders the failure copy (saw: ${alert})`);
    assert.ok(!bodyText().includes(SENT_COPY), "the sent copy must not render when nothing was asked");
  } finally {
    await cleanup();
  }
});
