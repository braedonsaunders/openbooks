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

test("a blank first row does not shift the refusal: the second grid row is named row 2", async () => {
  const restore = installFetch();
  // The server refuses the undescribed row by grid index, exactly as the route does.
  globalThis.__provisionPostStatus = {
    status: 400,
    body: { error: "permanentDifferences[1]: description is required when an amount is provided" },
  };
  const dialog = await mountDialog();
  try {
    // A second permanent line: the first stays blank.
    await click(buttonsNamed("Add line")[0]!);
    const amounts = inputsWithPlaceholder("0.00");
    assert.equal(amounts.length, 3);
    await act(async () => {
      setInputValue(amounts[1]!, "25000");
      await tick();
    });
    await tick();
    await click(buttonsNamed("Compute")[0]!);

    // Both rows travel unfiltered, so the server index equals the grid row.
    assert.equal(globalThis.__provisionPosts!.length, 1);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.permanentDifferences, [
      { description: "", amount: "" },
      { description: "", amount: "25000" },
    ]);
    // The 400 surfaces in the dialog, naming the grid row the preparer sees.
    const alert = document.querySelector('[role="alert"]');
    assert.equal(
      alert?.textContent,
      "Permanent differences row 2 needs a description \u2014 add one or clear the amount.",
    );
    assert.equal(globalThis.__provisionPushed!.length, 0);
  } finally {
    await dialog.unmount();
    restore();
  }
});

test("a described row with an empty amount refuses by row in translated copy", async () => {
  const restore = installFetch();
  globalThis.__provisionPostStatus = {
    status: 400,
    body: { error: "permanentDifferences[0]: amount is required when a description is provided" },
  };
  const dialog = await mountDialog();
  try {
    const descriptions = inputsWithPlaceholder("Description");
    await act(async () => {
      setInputValue(descriptions[0]!, "Meals");
      await tick();
    });
    await tick();
    await click(buttonsNamed("Compute")[0]!);

    assert.equal(globalThis.__provisionPosts!.length, 1);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.permanentDifferences, [
      { description: "Meals", amount: "" },
    ]);
    const alert = document.querySelector('[role="alert"]');
    assert.equal(
      alert?.textContent,
      "Permanent differences row 1 needs an amount \u2014 add one or clear the description.",
    );
    assert.equal(globalThis.__provisionPushed!.length, 0);
  } finally {
    await dialog.unmount();
    restore();
  }
});

test("a non-object grid element refusal renders in translated copy naming the row", async () => {
  const restore = installFetch();
  globalThis.__provisionPostStatus = {
    status: 400,
    body: { error: "permanentDifferences[0]: each row must be an object with description and amount" },
  };
  const dialog = await mountDialog();
  try {
    await click(buttonsNamed("Compute")[0]!);
    assert.equal(globalThis.__provisionPosts!.length, 1);
    const alert = document.querySelector('[role="alert"]');
    assert.equal(
      alert?.textContent,
      "Permanent differences row 1 must be a grid row with a description and an amount \u2014 fix the line and try again.",
    );
    assert.equal(globalThis.__provisionPushed!.length, 0);
  } finally {
    await dialog.unmount();
    restore();
  }
});

test("grid rows travel unfiltered and a valid grid with a pristine trailing row still saves", async () => {
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

    // The untouched trailing temporary row travels as-is (the server skips
    // pristine rows itself); the valid row saves.
    assert.equal(globalThis.__provisionPosts!.length, 1);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.permanentDifferences, [
      { description: "Meals", amount: "10.00" },
    ]);
    assert.deepEqual(globalThis.__provisionPosts![0]!.body.additionalDifferences, [
      { category: "other", description: "", difference: "" },
    ]);
    assert.deepEqual(globalThis.__provisionPushed, ["/tax/provisions/run-9"]);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally {
    await dialog.unmount();
    restore();
  }
});
