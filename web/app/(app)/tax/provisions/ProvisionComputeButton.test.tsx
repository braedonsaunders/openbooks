import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __provisionPosts: { url: string; body: Record<string, unknown> }[] | undefined;
  var __provisionPushed: string[] | undefined;
  var __provisionPostStatus: { status: number; body: unknown } | undefined;
}

// The compute dialog used to drop every undescribed grid row client-side, so
// a row with an amount but no description silently shrank the provision with
// a 201. Every non-blank row must now reach the server, the server's by-row
// 400 must surface in the dialog in translated copy naming the row, and a
// pristine trailing row must still save.

// jsdom first: the dialog reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/tax/provisions",
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
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(u){globalThis.__provisionPushed.push(u)},refresh(){}}}",
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
const messages = (await import("../../../../messages/en")).default;
const { ProvisionComputeButton } = await import("./ProvisionComputeButton");
hooks.deregister();

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function installFetch() {
  const prior = globalThis.fetch;
  globalThis.__provisionPosts = [];
  globalThis.__provisionPushed = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.endsWith("/api/tax/provisions") && (!init || !init.method || init.method === "GET")) {
      return Response.json({ fiscalYears: [2026], framework: "asc740" });
    }
    if (url.endsWith("/api/tax/provisions") && init?.method === "POST") {
      globalThis.__provisionPosts!.push({ url, body: JSON.parse(String(init.body)) });
      const stub = globalThis.__provisionPostStatus ?? { status: 201, body: { runId: "run-9" } };
      return Response.json(stub.body, { status: stub.status });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

function inputsWithPlaceholder(placeholder: string): HTMLInputElement[] {
  return [...document.querySelectorAll(`input[placeholder="${placeholder}"]`)] as HTMLInputElement[];
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function mountDialog() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ProvisionComputeButton />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await click(buttonsNamed("Compute provision")[0]!);
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

test("an amount without a description reaches the server and its refusal names the row in translated copy", async () => {
  const restore = installFetch();
  // The server refuses the undescribed row by row, exactly as the route does.
  globalThis.__provisionPostStatus = {
    status: 400,
    body: { error: "permanentDifferences[0]: description is required when an amount is provided" },
  };
  const dialog = await mountDialog();
  try {
    const amounts = inputsWithPlaceholder("0.00");
    assert.equal(amounts.length, 2);
    await act(async () => {
      setInputValue(amounts[0]!, "25000");
      await tick();
    });
    await tick();
    await click(buttonsNamed("Compute")[0]!);

    // The row was sent, not swallowed client-side.
    assert.equal(globalThis.__provisionPosts!.length, 1);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.permanentDifferences, [
      { description: "", amount: "25000" },
    ]);
    // The 400 surfaces in the dialog, naming the row the preparer sees.
    const alert = document.querySelector('[role="alert"]');
    assert.equal(
      alert?.textContent,
      "Permanent differences row 1 needs a description \u2014 add one or clear the amount.",
    );
    assert.equal(globalThis.__provisionPushed!.length, 0);
  } finally {
    await dialog.unmount();
    restore();
  }
});

test("a pristine trailing row is not sent and a valid grid still saves", async () => {
  const restore = installFetch();
  globalThis.__provisionPostStatus = { status: 201, body: { runId: "run-9" } };
  const dialog = await mountDialog();
  try {
    const descriptions = inputsWithPlaceholder("Description");
    const amounts = inputsWithPlaceholder("0.00");
    await act(async () => {
      setInputValue(descriptions[0]!, "Meals");
      setInputValue(amounts[0]!, "10.00");
      await tick();
    });
    await tick();
    await click(buttonsNamed("Compute")[0]!);

    // The untouched trailing temporary row (category on its "other"
    // default, no data) is blank and stays client-side; the valid row saves.
    assert.equal(globalThis.__provisionPosts!.length, 1);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.permanentDifferences, [
      { description: "Meals", amount: "10.00" },
    ]);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.additionalDifferences, []);
    assert.deepEqual(globalThis.__provisionPushed, ["/tax/provisions/run-9"]);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await dialog.unmount();
    restore();
  }
});
