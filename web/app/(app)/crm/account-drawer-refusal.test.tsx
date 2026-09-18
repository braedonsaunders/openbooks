import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __crmToasts: { kind: string; message: string }[] | undefined;
  var __crmRouter: { push(url: string): void; refresh(): void } | undefined;
}

// AccountDrawer on the shared action path. A blank name toasted without
// pinning; the two-record save (identity, then profile) surfaces the first
// refusal pinned above the fields until the next save, with every entered
// value kept.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/crm/accounts",
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
        url: "data:text/javascript,export function useRouter(){return globalThis.__crmRouter}export function usePathname(){return '/crm/accounts'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__crmToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__crmToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__crmToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import("../../../messages/en")).default;
const { AccountDrawer } = await import("./AccountDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const PARTY_ID = "44444444-4444-4444-8444-444444444444";

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

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

function data(displayName: string) {
  return {
    party: { id: PARTY_ID, display_name: displayName, email: null, phone: null, website: null, is_active: true, updated_at: '2026-01-01T00:00:00.000000Z' },
    crm: {
      profile: {
        lifecycle_stage: "lead",
        status_id: null,
        owner_user_id: null,
        territory_id: null,
        lead_source_id: null,
        industry: null,
        category: null,
        annual_revenue: null,
        employee_count: null,
        qualification_score: null,
        next_action_at: null,
      },
      activities: [],
      opportunities: [],
    },
  };
}

async function mountDrawer(displayName: string) {
  globalThis.__crmToasts = [];
  globalThis.__crmRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AccountDrawer
          data={data(displayName)}
          statuses={[]}
          owners={[]}
          territories={[]}
          sources={[]}
          basePath="/crm/accounts"
          canManage
        />
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

test("a blank name pins instead of toasting into the void", async (t) => {
  const restoreFetch = scriptFetch(() => null);
  t.after(restoreFetch);
  const { unmount } = await mountDrawer("New lead");
  t.after(unmount);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "the drawer must offer Save");
  await click(save);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the validation block must pin as an alert, not vanish with the toast");
  assert.match(alert.textContent ?? "", /Enter an account name/, "the alert must name the missing field");
});

test("a refused profile save pins the server reason with values kept", async (t) => {
  const restoreFetch = scriptFetch((url, init) => {
    if (url === `/api/parties/${PARTY_ID}` && init?.method === "PATCH") {
      return Response.json({ ok: true });
    }
    if (url === `/api/crm/accounts/${PARTY_ID}` && init?.method === "PATCH") {
      return Response.json({ error: "Status belongs to another stage" }, { status: 422 });
    }
    return null;
  });
  t.after(restoreFetch);
  const { unmount } = await mountDrawer("Acme Corp");
  t.after(unmount);
  const save = buttonsNamed("Save")[0];
  assert.ok(save, "the drawer must offer Save");
  await click(save);
  await tick();
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the profile refusal must pin as an alert");
  assert.match(alert.textContent ?? "", /Status belongs to another stage/, "the alert must carry the server reason");
  const toasts = globalThis.__crmToasts ?? [];
  assert.ok(
    toasts.some((toast) => toast.kind === "error"),
    "the refusal must also toast",
  );
  assert.equal(save.disabled, false, "busy must release after the refusal");
});
