import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __gateToasts: { kind: string; message: string }[] | undefined;
  var __gateRouter: { push(url: string): void; refresh(): void } | undefined;
  var __gateRefreshes: number | undefined;
}

// Approving with no linked person answered 422 with the remedy, but the
// row showed only a toast and then refreshed — the explanation vanished
// while the approval stayed pending. The refusal now pins beside the
// row's actions until the next action, survives (no refresh wipes it),
// and is never turned into an approval.

// jsdom first: the row reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/inbox", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__gateRouter}" +
      "export function usePathname(){return '/inbox'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner:
      "export const toast={success(m){(globalThis.__gateToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__gateToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__gateToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
    "../../../lib/prompt": "export async function promptDialog(){return 'test reason'}",
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { GateActions } = await import("./GateActions");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const GATE_ID = "44444444-4444-4444-8444-444444444444";
const REFUSAL =
  "the approver has no linked person — link the approver to a person in Admin → Users → Link person before they decide";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init) ?? Response.json({});
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

function alert(): HTMLElement | null {
  return document.querySelector('[role="alert"]');
}

async function mountRow() {
  globalThis.__gateToasts = [];
  globalThis.__gateRefreshes = 0;
  globalThis.__gateRouter = {
    push() {},
    refresh() {
      globalThis.__gateRefreshes = (globalThis.__gateRefreshes ?? 0) + 1;
    },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <GateActions gateId={GATE_ID} canDelegate={false} users={[]} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
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

async function clickApprove() {
  const approve = buttonsNamed("Approve")[0];
  assert.ok(approve, "the row must offer Approve");
  await act(async () => {
    approve.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
}

test("a refused decide pins the remedy to the row instead of refreshing it away", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/flows/gates/decide" && init?.method === "POST") {
      return Response.json({ error: REFUSAL }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountRow();
  t.after(unmount);

  await clickApprove();

  const pinned = alert();
  assert.ok(pinned, "the refusal must pin beside the row's actions");
  assert.ok(
    pinned.textContent?.includes("no linked person"),
    "the pin carries the server refusal with its remedy",
  );
  assert.ok(
    pinned.textContent?.includes("Link person"),
    "the operator reads what to do next",
  );
  assert.equal(globalThis.__gateRefreshes, 0, "no refresh wipes the explanation away");
  assert.ok(
    (globalThis.__gateToasts ?? []).some((toast) => toast.kind === "error"),
    "the refusal still toasts",
  );
  assert.ok(
    !(globalThis.__gateToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("Approved"),
    ),
    "a refusal is never turned into an approval",
  );
  // The pin survives: still there after the dust settles.
  await tick();
  await tick();
  assert.ok(alert(), "the pin persists until the next action");
});

test("a recorded decide clears the pin and refreshes", async (t) => {
  let calls = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url === "/api/flows/gates/decide" && init?.method === "POST") {
      calls += 1;
      if (calls === 1) return Response.json({ error: REFUSAL }, { status: 422 });
      return Response.json({ ok: true, resumed: "approve", runStatus: "completed" });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountRow();
  t.after(unmount);

  await clickApprove();
  assert.ok(alert(), "the first refusal pins");
  await clickApprove();
  assert.equal(alert(), null, "a recorded decision clears the pin");
  assert.equal(globalThis.__gateRefreshes, 1, "success refreshes exactly once");
});
