import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// The invoice send dialog printed the record-PDF boundary's raw machine code
// ("PDF not_found"): the uniform 404 stays { error: "not_found" } by design
// so a probe learns nothing, which means the CLIENT must map opaque codes to
// the localized failure with a retry — never the raw code. Actionable server
// sentences (no recipient, no transport) still read verbatim.

// jsdom first: Popover/Button read browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/ar/invoices", matchMediaMatches: false });

declare global {
  var __sendNotFoundToasts: { kind: string; message: string }[] | undefined;
  var __sendNotFoundPosts: number | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__sendNotFoundToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__sendNotFoundToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../messages/en")).default;
const { SendButton } = await import("./send-button");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function openComposer() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SendButton recordType="customer_invoice" recordId="INV-T404" />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  const openers = buttonsNamed("Send");
  assert.ok(openers.length >= 1, "the Send trigger must render");
  await act(async () => {
    openers[openers.length - 1]!.click();
    await tick();
  });
  const toInput = document.querySelector("#send-to") as HTMLInputElement | null;
  assert.ok(toInput, "the recipient field must render");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(toInput, "billing@t404.example");
    toInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  return { host, root };
}

test("a not_found send failure shows the localized message with retry, never the raw code", async () => {
  (globalThis as Record<string, unknown>).__sendNotFoundToasts = [];
  (globalThis as Record<string, unknown>).__sendNotFoundPosts = 0;
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "POST") {
      (globalThis as Record<string, unknown>).__sendNotFoundPosts =
        Number((globalThis as Record<string, unknown>).__sendNotFoundPosts ?? 0) + 1;
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Response.json({ to: null });
  }) as typeof fetch;
  try {
    const { host, root } = await openComposer();
    try {
      await act(async () => {
        buttonsNamed("Send email")[0]!.click();
        await tick();
      });
      await act(async () => {
        await tick();
      });
      const alert = document.querySelector('[role="alert"]');
      assert.ok(alert, "the failure pins inside the dialog");
      assert.doesNotMatch(alert!.textContent ?? "", /not_found/, "the raw machine code never renders");
      assert.match(alert!.textContent ?? "", /Could not send the email/, "the localized failure renders instead");
      const retry = buttonsNamed("Retry")[0];
      assert.ok(retry, "the failure offers a retry");
      await act(async () => {
        retry!.click();
        await tick();
      });
      await act(async () => {
        await tick();
      });
      assert.equal(
        Number((globalThis as Record<string, unknown>).__sendNotFoundPosts),
        2,
        "retry re-attempts the send through the same path",
      );
    } finally {
      root.unmount();
      host.remove();
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test("an actionable send refusal still reads verbatim beside the retry", async () => {
  (globalThis as Record<string, unknown>).__sendNotFoundToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({ error: "no recipient email — add an email address to the customer first" }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    }
    return Response.json({ to: null });
  }) as typeof fetch;
  try {
    const { host, root } = await openComposer();
    try {
      await act(async () => {
        buttonsNamed("Send email")[0]!.click();
        await tick();
      });
      await act(async () => {
        await tick();
      });
      const alert = document.querySelector('[role="alert"]');
      assert.ok(alert, "the failure pins inside the dialog");
      assert.match(
        alert!.textContent ?? "",
        /add an email address to the customer/,
        "an actionable server sentence still reads verbatim",
      );
      assert.ok(buttonsNamed("Retry")[0], "verbatim failures offer the same retry");
    } finally {
      root.unmount();
      host.remove();
    }
  } finally {
    globalThis.fetch = prior;
  }
});
