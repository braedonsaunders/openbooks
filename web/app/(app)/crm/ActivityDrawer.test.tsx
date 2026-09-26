import assert from "node:assert/strict";
import test from "node:test";

// The activity drawer PATCHed with no revision token, so the last
// writer won silently — and a 409 came back as a generic failure. The save
// must echo the loader-projected updated_at as expectedUpdatedAt, and a
// stale-token 409 must surface the server's named refusal in the toast.

declare global {
  var __activityPatchBodies: Record<string, unknown>[] | undefined;
  var __activityToastErrors: string[] | undefined;
  var __activityPatchStatus: { status: number; body: unknown } | undefined;
}

const { bootJsdomEnvironment } = await import("../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/crm/activities?activity=act-1", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ navigation: { pathname: "/crm/activities" } });
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(m){(globalThis.__activityToastErrors ??= []).push(String(m))},warning(){}};export function Toaster(){return null}",
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
