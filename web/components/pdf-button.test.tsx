import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// The record PDF button prints a saved record only, and a refused print
// surfaces the server's reason in a toast instead of a raw response tab.

declare global {
  var __pdfButtonToasts: { kind: string; message: string }[] | undefined;
}

const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills" });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__pdfButtonToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__pdfButtonToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { PdfButton } = await import("./pdf-button");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

type FakeTab = { closed: boolean; location: { href: string }; close(): void };

async function mount(t: TestContext, recordId: string, pdf: () => Response) {
  const toasts: { kind: string; message: string }[] = [];
  (globalThis as Record<string, unknown>).__pdfButtonToasts = toasts;
  const requested: string[] = [];
  const tabs: FakeTab[] = [];
  const priorFetch = globalThis.fetch;
  const priorOpen = window.open;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/options")) {
      return Promise.resolve(
        new Response(JSON.stringify({ rows: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(pdf());
  }) as typeof fetch;
  window.open = (() => {
    const tab: FakeTab = {
      closed: false,
      location: { href: "about:blank" },
      close() {
        this.closed = true;
      },
    };
    tabs.push(tab);
    return tab as unknown as Window;
  }) as typeof window.open;
  URL.createObjectURL = () => "blob:http://localhost:4800/pdf";
  URL.revokeObjectURL = () => {};
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PdfButton recordType="vendor_bill" recordId={recordId} />
      </NextIntlClientProvider>,
    );
  });
  t.after(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.fetch = priorFetch;
    window.open = priorOpen;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
  });
  const button = host.querySelector("button") as HTMLButtonElement;
  return { button, toasts, requested, tabs };
}

test("an unsaved record cannot be printed and requests nothing", async (t) => {
  const { button, requested, tabs } = await mount(t, "", () => new Response("unused"));
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Save the record to print it.");
  await act(async () => {
    button.click();
    await tick();
  });
  assert.deepEqual(requested, []);
  assert.equal(tabs.length, 0);
});

test("a refused print shows the server reason and closes the tab it opened", async (t) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const { button, toasts, requested, tabs } = await mount(
    t,
    id,
    () =>
      new Response(JSON.stringify({ error: "template not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
  );
  await act(async () => {
    button.click();
    await tick();
  });
  assert.deepEqual(requested, [
    `/api/record-pdf/vendor_bill/options`,
    `/api/record-pdf/vendor_bill/${id}`,
  ]);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]!.closed, true);
  assert.equal(tabs[0]!.location.href, "about:blank");
  assert.deepEqual(toasts, [{ kind: "error", message: "template not found" }]);
});

test("a produced PDF opens in the tab opened for it", async (t) => {
  const id = "22222222-2222-4222-8222-222222222222";
  const { button, toasts, tabs } = await mount(
    t,
    id,
    () =>
      new Response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "Content-Type": "application/pdf" },
      }),
  );
  await act(async () => {
    button.click();
    await tick();
  });
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0]!.closed, false);
  assert.equal(tabs[0]!.location.href, "blob:http://localhost:4800/pdf");
  assert.deepEqual(toasts, []);
});
