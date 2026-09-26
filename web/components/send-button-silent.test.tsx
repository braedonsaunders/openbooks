import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// Actions > Send on a payable invoice silently failed — the dialog
// closed with no toast on the 422 (email delivery not configured). The send
// dialog must stay open and surface the server error.

// jsdom first: Popover/Button read browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/ar/invoices", matchMediaMatches: false });

declare global {
  var __sendToasts: { kind: string; message: string }[] | undefined;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__sendToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__sendToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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

test("a failed invoice send keeps the dialog open and toasts the error", async () => {
  (globalThis as Record<string, unknown>).__sendToasts = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "email delivery is not configured" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <SendButton recordType="customer_invoice" recordId="INV-T124" />
        </NextIntlClientProvider>,
      );
      await tick();
    });

    // Open the popover, then click Send.
    const openers = buttonsNamed("Send");
    assert.ok(openers.length >= 1, "the Send trigger must render");
    await act(async () => {
      openers[openers.length - 1]!.click();
      await tick();
    });
    const senders = buttonsNamed("Send email");
    assert.ok(senders.length >= 1, "the Send email action must render");
    // The composer starts with a blank recipient in isolation (production
    // prefills it via GET); without an address send() bails before fetching.
    const toInput = document.querySelector("#send-to") as HTMLInputElement | null;
    assert.ok(toInput, "the recipient field must render");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(toInput, "billing@t02f7.example");
      toInput.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    await act(async () => {
      senders[senders.length - 1]!.click();
      await tick();
    });
    await act(async () => {
      await tick();
    });

    const toasts = (globalThis as Record<string, unknown>).__sendToasts as {
      kind: string;
      message: string;
    }[];
    assert.ok(
      toasts.some((t) => t.kind === "error"),
      `a failed send must toast an error, got ${JSON.stringify(toasts)}`,
    );
    assert.ok(
      buttonsNamed("Send email").length >= 1,
      "the send dialog must stay open on failure",
    );
    // The failure must also persist inside the dialog: a 4s toast alone is
    // what the tester missed. RED half.
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert, "the send dialog must show the failure inline");
    assert.match(
      alert!.textContent ?? "",
      /email delivery is not configured/,
      "the inline failure must carry the server's reason",
    );
    root.unmount();
    host.remove();
  } finally {
    globalThis.fetch = prior;
  }
});
