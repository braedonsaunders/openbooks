import assert from "node:assert/strict";
import test from "node:test";

// F3-71: the activity drawer PATCHed with no revision token, so the last
// writer won silently — and a 409 came back as a generic failure. The save
// must echo the loader-projected updated_at as expectedUpdatedAt, and a
// stale-token 409 must surface the server's named refusal in the toast.

declare global {
  var __activityPatchBodies: Record<string, unknown>[] | undefined;
  var __activityToastErrors: string[] | undefined;
  var __activityPatchStatus: { status: number; body: unknown } | undefined;
}

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/crm/activities?activity=act-1",
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
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return {push(){},refresh(){},replace(){}}}export function usePathname(){return '/crm/activities'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(m){(globalThis.__activityToastErrors ??= []).push(String(m))},warning(){}};export function Toaster(){return null}",
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
const { ActivityDrawer } = await import("./ActivityDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const TOKEN = "2026-09-17T12:00:00.000000Z";
const REFUSAL = "This activity changed after you opened it; reload the activity and reapply your changes";

function installFetch() {
  const prior = globalThis.fetch;
  globalThis.__activityPatchBodies = [];
  globalThis.__activityToastErrors = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      globalThis.__activityPatchBodies!.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const stub = globalThis.__activityPatchStatus ?? { status: 409, body: { error: REFUSAL } };
      return Response.json(stub.body, { status: stub.status });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mountDrawer() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ActivityDrawer
          data={{
            activity: {
              id: "act-1",
              kind: "task",
              status: "planned",
              priority: "normal",
              subject: "Call about renewal",
              body: null,
              assigned_user_id: null,
              starts_at: null,
              ends_at: null,
              due_at: null,
              updated_at: TOKEN,
            },
            links: [],
          }}
          owners={[]}
          accounts={[]}
          opportunities={[]}
          closeHref="/crm/activities"
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

test("the drawer echoes the revision token and surfaces the stale-token refusal by name", async () => {
  const restore = installFetch();
  const drawer = await mountDrawer();
  try {
    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Save",
    ) as HTMLButtonElement;
    assert.ok(save, "a Save action must render for managers");
    await act(async () => {
      save.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
    });
    await tick();
    assert.equal(globalThis.__activityPatchBodies!.length, 1);
    assert.equal(globalThis.__activityPatchBodies![0]!.expectedUpdatedAt, TOKEN);
    assert.deepEqual(globalThis.__activityToastErrors, [REFUSAL]);
  } finally {
    await drawer.unmount();
    restore();
  }
});
