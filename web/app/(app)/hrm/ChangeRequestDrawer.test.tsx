import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";

// The employment change drawer never fails silently: a local refusal names
// the field, focuses it, and toasts; a server refusal renders its message
// inline and as a toast (res.ok is checked before any body is parsed).

await bootJsdomEnvironment({ url: "http://localhost:4800/hrm", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__crRouter}export function usePathname(){return '/hrm'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

Object.assign(globalThis, {
  __crRouter: { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} },
  __crToasts: [] as { kind: string; message: string }[],
});

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){globalThis.__crToasts.push({kind:'success',message:m})},error(m){globalThis.__crToasts.push({kind:'error',message:m})}};export function Toaster(){return null}",
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

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { ChangeRequestDrawer } = await import("./ChangeRequestDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const EMPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";

type Reply = () => Response;

/**
 * Scripted API: the create route answers `create`, the submit route answers
 * `submit`. Every POST is recorded so a test can assert what was (not) sent.
 */
function scriptFetch(create: Reply, submit: Reply) {
  const prior = globalThis.fetch;
  const posts: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/hrm/change-requests") {
      posts.push(url);
      return create();
    }
    if (method === "POST" && url.endsWith("/submit")) {
      posts.push(url);
      return submit();
    }
    if (url.includes("/api/hrm/action-reasons")) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (url.includes("/api/hrm/options")) return Response.json({ options: [] });
    return Response.json({});
  }) as typeof fetch;
  return {
    posts,
    restore() {
      globalThis.fetch = prior;
    },
  };
}

async function mountDrawer() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls = { closed: 0, saved: 0 };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-10-01">
          <ChangeRequestDrawer
            employmentId={EMPLOYMENT_ID}
            initialRequest={null}
            initialValues={{ kind: "assignment_change" }}
            departmentOptions={[]}
            onClose={() => {
              calls.closed += 1;
            }}
            onSaved={() => {
              calls.saved += 1;
            }}
          />
        </BusinessDateProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return {
    calls,
    async done() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  );
  assert.ok(found, `a "${name}" action must render`);
  return found as HTMLButtonElement;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function typeIntoId(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  assert.ok(el, `the #${id} field must render`);
  await act(async () => {
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

function toastedErrors(): string[] {
  return (globalThis as unknown as { __crToasts: { kind: string; message: string }[] }).__crToasts
    .filter((entry) => entry.kind === "error")
    .map((entry) => entry.message);
}

test("a blank assignment key refuses before posting, focuses the key, and toasts the reason", async (t) => {
  (globalThis as unknown as { __crToasts: unknown[] }).__crToasts.length = 0;
  const fetch = scriptFetch(
    () => Response.json({ request: { id: "r1" } }, { status: 201 }),
    () => Response.json({ request: { status: "pending_approval" } }),
  );
  const mounted = await mountDrawer();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await typeIntoId("cr-reason", "Move to Finance");
  await click(buttonNamed("Submit for approval"));
  assert.equal(fetch.posts.length, 0, "a refused proposal must not post");
  const expected = "Name the assignment slot this change edits.";
  assert.ok(toastedErrors().includes(expected), "the refusal must toast");
  assert.ok(
    document.querySelector('[role="alert"]')?.textContent?.includes(expected),
    "the refusal must render inline",
  );
  assert.equal(
    (document.activeElement as HTMLElement | null)?.getAttribute("id"),
    "cr-assignment-key",
    "the refusal must focus the field to fix",
  );
  assert.equal(mounted.calls.closed, 0, "the drawer must stay open with the typed work");
});

test("a server refusal on submit renders its message inline and as a toast", async (t) => {
  (globalThis as unknown as { __crToasts: unknown[] }).__crToasts.length = 0;
  const refusal = "this employment has no effective version yet — file a hire before changing it";
  const fetch = scriptFetch(
    () => Response.json({ request: { id: "r1" } }, { status: 201 }),
    () => Response.json({ error: refusal }, { status: 409 }),
  );
  const mounted = await mountDrawer();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await typeIntoId("cr-assignment-key", "primary");
  await typeIntoId("cr-reason", "Move to Finance");
  await click(buttonNamed("Submit for approval"));
  assert.equal(fetch.posts.length, 2, "the draft is created, then its submit is refused");
  assert.ok(
    document.querySelector('[role="alert"]')?.textContent?.includes(refusal),
    "the refusal must render inline",
  );
  assert.ok(toastedErrors().includes(refusal), "the refusal must toast");
  assert.equal(mounted.calls.saved, 0, "a refused submit must not report a saved change");
  assert.equal(mounted.calls.closed, 0, "the drawer must stay open after a refusal");
});

test("a draft save that returns no request id reports a failure instead of closing silently", async (t) => {
  (globalThis as unknown as { __crToasts: unknown[] }).__crToasts.length = 0;
  const fetch = scriptFetch(
    () => Response.json({}, { status: 201 }),
    () => Response.json({}),
  );
  const mounted = await mountDrawer();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await typeIntoId("cr-assignment-key", "primary");
  await click(buttonNamed("Save as draft"));
  const expected = "The change request could not be saved.";
  assert.ok(
    toastedErrors().includes(expected),
    "a success without a draft id must toast a failure",
  );
  assert.ok(
    document.querySelector('[role="alert"]')?.textContent?.includes(expected),
    "the failure must render inline",
  );
  assert.equal(mounted.calls.closed, 0, "the drawer must stay open");
});
