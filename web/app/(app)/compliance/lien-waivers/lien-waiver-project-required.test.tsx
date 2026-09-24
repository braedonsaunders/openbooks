import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __waiverRouter: { push(url: string): void; refresh(): void } | undefined;
  var __waiverToasts: { kind: string; message: string }[] | undefined;
  var __waiverPosts: unknown[] | undefined;
}

// F-t03-006: creating a lien waiver without a project fired no request and
// (as filed) showed no message — indistinguishable from a dead button. The
// validation message exists in current code; what was missing is the
// fleet-wide contract for user-triggerable refusals: the message must pin
// as a record-level alert (announced, persistent until the next attempt),
// not a plain paragraph.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/compliance/lien-waivers",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__waiverRouter}export function usePathname(){return '/compliance/lien-waivers'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__waiverToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__waiverToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { LienWaiverToolbar } = await import("./LienWaiverToolbar");
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("creating a waiver requires an explicit type choice and posts nothing without it (F3-80)", async (t) => {
  globalThis.__waiverRouter = { push() {}, refresh() {} };
  globalThis.__waiverToasts = [];
  globalThis.__waiverPosts = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/compliance/lien-waivers" && (init?.method ?? "GET") === "POST") {
      globalThis.__waiverPosts!.push(init?.body);
    }
    return Response.json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-09-17">
          <LienWaiverToolbar
          direction=""
          status=""
          projects={[{ id: "project-1", label: "JOB-T03-01" }]}
          vendors={[{ id: "vendor-1", label: "Regional Telecom", defaultType: "conditional_progress" }]}
          canManage
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  const opener = buttonsNamed("New waiver")[0];
  assert.ok(opener, "the toolbar must offer New waiver");
  await click(opener);
  const create = buttonsNamed("Create waiver")[0];
  assert.ok(create, "the dialog must offer Create waiver");
  const waiverType = document.querySelectorAll("select")[3] as HTMLSelectElement;
  assert.equal(waiverType.value, "", "the form must not preselect an unconditional release");
  await click(create);
  await tick();
  assert.equal(
    (globalThis.__waiverPosts ?? []).length,
    0,
    "no POST may fire without a project",
  );
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the missing-project reason must pin as a record alert");
  assert.match(
    alert.textContent ?? "",
    /Choose the waiver type explicitly/,
    "the alert must require an explicit waiver choice",
  );
});
