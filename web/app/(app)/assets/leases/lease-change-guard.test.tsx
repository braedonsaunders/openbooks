// F2-13: the lease change/terminate popover never replays another lease's
// terms or another proposal's idempotency key. Switching leases remounts
// the drawer (keyed by lease id), and every popover open resets the form
// to the current lease with a fresh key — so a proposal for lease B is
// never pre-filled with A's terms nor refused as a replay of A.

import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assets/leases?lease=lease-a",
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

const script = { bodies: [] as Record<string, unknown>[] };
Object.assign(globalThis, {
  __leaseChange: script,
  __leaseChangeRouter: { push() {}, replace() {}, refresh() {} },
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__leaseChangeRouter}export function usePathname(){return '/assets/leases'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
      };
    }
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
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
const { MoneyProvider } = await import("../../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { LeaseDrawer } = await import("./LeaseDrawer");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function lease(id: string, payment: string) {
  return {
    id,
    lease_number: `LN-${id.slice(-1).toUpperCase()}`,
    description: null,
    status: "active",
    subsidiary_id: "sub-1",
    commencement_on: "2026-01-01",
    term_periods: 12,
    payment_frequency: "monthly",
    payment_timing: "advance",
    payment_amount: payment,
    annual_discount_rate_percent: "5.0000",
    classification: "finance",
    initial_liability: "11500.00",
    initial_rou_asset: "11500.00",
    revision: 1,
    classification_inputs: {},
  };
}

function payloadFor(id: string, payment: string) {
  return { lease: lease(id, payment), schedule: [], changes: [] };
}

type Payload = ReturnType<typeof payloadFor>;

/**
 * Deliberately keyless (like a parent that forgets the key): switching the
 * payload must still reset the form through the component's own lease-id
 * reset, never through a remount the test smuggles in.
 */
function Page({ payload }: { payload: Payload }) {
  return (
    <BusinessDateProvider today="2026-09-17">
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <LeaseDrawer
            payload={payload as never}
            accounts={[]}
            subsidiaries={[]}
            canManage
          />
        </MoneyProvider>
      </NextIntlClientProvider>
    </BusinessDateProvider>
  );
}

async function mount(payload: Payload) {
  script.bodies = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/leases/") && url.endsWith("/changes") && init?.method === "POST") {
      script.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true, id: "change-1" });
    }
    return Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Page payload={payload} />);
    await tick();
  });
  await tick(60);
  return {
    rerender: async (next: Payload) => {
      await act(async () => {
        root.render(<Page payload={next} />);
        await tick();
      });
      await tick(60);
    },
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function openChangePopover() {
  const trigger = buttonsNamed("Change / terminate")[0];
  assert.ok(trigger, "an active lease must offer the change popover");
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(120);
  });
  await tick(120);
}

function paymentInput(): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find(
    (l) => l.textContent?.trim() === "Revised payment",
  );
  assert.ok(label, "the change form must label the revised payment");
  // The label sits in a hint row above the input inside the same field
  // wrapper — walk up until the input appears.
  let scope: Element | null = label.parentElement;
  let input: HTMLInputElement | null = null;
  while (scope && !input) {
    input = scope.querySelector("input");
    scope = scope.parentElement;
  }
  assert.ok(input, "the change form must show the per-period payment");
  return input;
}

async function setPayment(value: string) {
  await act(async () => {
    const input = paymentInput();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick(60);
}

async function propose() {
  const button = buttonsNamed("Create approval proposal")[0];
  assert.ok(button, "the change form must offer Create approval proposal");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(200);
  });
  await tick(200);
}

test("reopening the popover resets the form and rotates the idempotency key", async (t) => {
  const { cleanup } = await mount(payloadFor("lease-a", "1000.00"));
  t.after(cleanup);

  await openChangePopover();
  assert.equal(paymentInput().value, "1000.00", "the form starts from the current lease terms");
  await setPayment("2000.00");
  await propose();
  assert.equal(script.bodies.length, 1, "the first proposal posts once");
  const firstKey = (script.bodies[0] as { idempotencyKey?: string }).idempotencyKey;
  assert.ok(firstKey, "proposals carry an idempotency key");

  // Reopen without switching leases: the form must be back on the lease
  // terms with a FRESH key, not the typed 2000 with the spent key.
  await openChangePopover();
  assert.equal(paymentInput().value, "1000.00", "reopening resets typed terms back to the lease");
  await propose();
  assert.equal(script.bodies.length, 2, "the second proposal posts once");
  const secondKey = (script.bodies[1] as { idempotencyKey?: string }).idempotencyKey;
  assert.ok(secondKey && secondKey !== firstKey, "each open mints its own idempotency key");
});

test("switching leases shows the new lease terms, never the old typed ones", async (t) => {
  const { rerender, cleanup } = await mount(payloadFor("lease-a", "1000.00"));
  t.after(cleanup);

  await openChangePopover();
  await setPayment("2000.00");
  assert.equal(paymentInput().value, "2000.00");

  await rerender(payloadFor("lease-b", "5000.00"));
  await openChangePopover();
  assert.equal(
    paymentInput().value,
    "5000.00",
    "lease B opens with its own terms, not lease A's typed leftovers",
  );
});
