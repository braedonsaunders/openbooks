import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the form reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/sign/test-token",
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

declare global {
  var __signTestRouter: { refreshes: number; refresh(): void } | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__signTestRouter}export function usePathname(){return '/sign/test-token'}export function useSearchParams(){return new URLSearchParams()}",
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
const { SignDocumentForm } = await import("./SignDocumentForm");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function mountForm(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  acknowledgmentOnly = false,
) {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  globalThis.__signTestRouter = {
    refreshes: 0,
    refresh() {
      this.refreshes += 1;
    },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <SignDocumentForm token="test-token" signerStatus="pending" acknowledgmentOnly={acknowledgmentOnly} />,
    );
    await tick();
  });
  return {
    async cleanup() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      globalThis.fetch = priorFetch;
    },
  };
}

async function signAs(name: string) {
  const input = document.querySelector('[aria-label="Your name"]') as HTMLInputElement;
  assert.ok(input, "sign form must ask for the typed name");
  await act(async () => {
    typeInto(input, name);
  });
  await tick();
  const sign = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Sign document"),
  ) as HTMLButtonElement;
  assert.ok(sign, "sign form must offer Sign document");
  await act(async () => {
    sign.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
}

/**
 * OM-07: after a successful sign the server-rendered status and timeline
 * still showed the pre-sign state until a manual reload. The form must
 * refresh the server parts on success so Status, timeline and thank-you
 * agree immediately — while the confirmation itself stays put.
 */
test("a successful sign refreshes the server-rendered status while keeping the thank-you", async (t) => {
  const mounted = await mountForm(async () => Response.json({ ok: true }));
  t.after(() => mounted.cleanup());

  await signAs("Sara Lee");

  assert.match(
    document.body.textContent ?? "",
    /signature is recorded/,
    "the thank-you confirmation must render after signing",
  );
  assert.equal(
    globalThis.__signTestRouter?.refreshes,
    1,
    "success must refresh the server-rendered status and timeline — no manual reload",
  );
});

/** The acknowledge path renders its own thank-you (the raw 'acknowledge'
 * action used to fall through every branch and leave an empty box). */
test("a successful acknowledgment renders its thank-you and refreshes", async (t) => {
  const mounted = await mountForm(async () => Response.json({ ok: true }), true);
  t.after(() => mounted.cleanup());

  const acknowledge = [...document.querySelectorAll("button")].find((el) =>
    el.textContent?.trim().startsWith("Acknowledge"),
  ) as HTMLButtonElement;
  assert.ok(acknowledge, "acknowledgment-only form must offer Acknowledge");
  await act(async () => {
    acknowledge.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();

  assert.match(
    document.body.textContent ?? "",
    /acknowledgment is recorded/,
    "the acknowledgment thank-you must render after recording",
  );
  assert.equal(
    globalThis.__signTestRouter?.refreshes,
    1,
    "acknowledgment must also refresh the server-rendered timeline",
  );
});

/** A refused sign must surface the refusal, not a refresh that hides it. */
test("a failed sign shows the error and does not refresh", async (t) => {
  const mounted = await mountForm(async () =>
    Response.json({ error: "link_expired" }, { status: 410 }),
  );
  t.after(() => mounted.cleanup());

  await signAs("Sara Lee");

  assert.match(document.body.textContent ?? "", /link_expired/, "the refusal must reach the signer");
  assert.doesNotMatch(
    document.body.textContent ?? "",
    /signature is recorded/,
    "a refused sign must never render the thank-you",
  );
  assert.equal(
    globalThis.__signTestRouter?.refreshes ?? 0,
    0,
    "failure must not refresh away the error state",
  );
});
