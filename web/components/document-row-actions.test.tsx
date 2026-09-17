import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

declare global {
  var __docRowRouter: { push(): void; refresh(): void } | undefined;
  var __docRowToasts: { kind: string; message: string }[] | undefined;
}

// jsdom first: the row actions read browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ap/bills",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__docRowRouter}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__docRowToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__docRowToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../messages/en")).default;
const { DocumentRowActions } = await import("./document-row-actions");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const config = DOC_KINDS["vendor_bill"]!;

async function mountApprovedRow() {
  globalThis.__docRowRouter = {
    push() {},
    refresh() {},
  };
  globalThis.__docRowToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentRowActions id={randomUUID()} status="approved" config={config} openHref="/ap/bills/1" />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  return { host, root };
}

async function clickPost(host: HTMLElement) {
  const post = host.querySelector('button[aria-label="Post"]') as HTMLButtonElement;
  assert.ok(post, "post button must render");
  // Dispatch inside act; settle outside it so a rejection escaping the
  // handler cannot reject into act and poison later mounts.
  await act(async () => {
    post.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tick();
  await tick();
  await tick();
}

/** F-t04-006: a refused Post must name the reason instead of failing silently. */
test("a 422 post refusal surfaces the typed server reason", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "AP is closed for this period and accounting book" }, { status: 422 })) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const errors = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "the refused post must surface exactly one error toast");
  assert.match(errors[0]!.message, /AP is closed/i);
});

test("a non-JSON post failure still releases the button with an error", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>proxy boom</html>", { status: 500 })) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const errors = (globalThis.__docRowToasts ?? []).filter((toast) => toast.kind === "error");
  assert.equal(errors.length, 1, "a failed post must surface an error toast");
  const post = [...host.querySelectorAll("button")][0] as HTMLButtonElement;
  assert.equal(post.disabled, false, "the post button must release after the failure");
});

/** Posting-refusal persistence (coordinator follow-up on F-t04-006): the
 * typed 422 reason must persist as a row-inline role=alert until the next
 * action — a 4s toast alone reads as "nothing happened". */
test("a 422 post refusal persists as a row-inline alert until the next action", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ error: "AP is closed for this period and accounting book" }, { status: 422 })) as typeof fetch;
  const { host, root } = await mountApprovedRow();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  });
  await clickPost(host);
  await tick();
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, "the refused post must persist a row-inline alert");
  assert.match(alert.textContent ?? "", /AP is closed/i);

  // The next action clears it: a successful post leaves no stale refusal.
  globalThis.fetch = (async () => Response.json({ ok: true }, { status: 200 })) as typeof fetch;
  await clickPost(host);
  await tick();
  assert.equal(host.querySelector('[role="alert"]'), null, "a later action must clear the refusal alert");
});
