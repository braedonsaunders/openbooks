import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env.ts";

// The Hire action drawer never fails silently: required fields carry inline
// errors, submit focuses the first invalid field, and a server refusal
// renders with its message (res.ok is checked before any body is parsed).

await bootJsdomEnvironment({ url: "http://localhost:4800/hrm", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__hireRouter}export function usePathname(){return '/hrm'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
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
        url: "data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}",
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
const { HireEmploymentDrawer } = await import("./HireEmploymentDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

Object.assign(globalThis, {
  __hireRouter: { push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} },
});

type PostCall = { url: string; body: Record<string, unknown> };

function scriptFetch(post: () => Response) {
  const prior = globalThis.fetch;
  const posts: PostCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.includes("/api/hrm/employments") && (init?.method ?? "GET") === "POST") {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return post();
    }
    if (url.includes("/api/hrm/options")) {
      const query = new URL(url, "http://localhost:4800").searchParams;
      if (
        query.get("source") === "employer-subsidiaries" &&
        !query.get("q") &&
        !query.get("include")
      ) {
        // A single visible entity preselects, so the employer is filled.
        return Response.json({ options: [{ subsidiaryId: "emp-1", label: "Employer One" }] });
      }
      return Response.json({ options: [] });
    }
    return Response.json({});
  }) as typeof fetch;
  return {
    posts,
    restore() {
      globalThis.fetch = prior;
    },
  };
}

async function mountHire() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let saved = 0;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-10-01">
          <HireEmploymentDrawer
            partyId="person-1"
            partyName="Pat Candidate"
            onClose={() => {}}
            onSaved={() => {
              saved += 1;
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
    host,
    saved: () => saved,
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

test("an empty reason shows an inline error and focuses the field without posting", async (t) => {
  const fetch = scriptFetch(() =>
    Response.json({ employment: { id: "e1" }, request: { id: "r1" } }),
  );
  const mounted = await mountHire();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await click(buttonNamed("Record hire"));
  assert.equal(fetch.posts.length, 0, "an invalid hire must not post");
  const reasonField = document.getElementById("hire-reason")?.parentElement;
  assert.ok(
    reasonField?.textContent?.includes("Record why the change is proposed."),
    "the reason field must carry its inline error",
  );
  assert.equal(
    (document.activeElement as HTMLElement | null)?.getAttribute("id"),
    "hire-reason",
    "submit must focus the first invalid field",
  );
});

test("an empty assignment key shows an inline error without posting", async (t) => {
  const fetch = scriptFetch(() =>
    Response.json({ employment: { id: "e1" }, request: { id: "r1" } }),
  );
  const mounted = await mountHire();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await typeIntoId("hire-reason", "Backfill for parental leave");
  await typeIntoId("hire-assignment-key", "");
  await click(buttonNamed("Record hire"));
  assert.equal(fetch.posts.length, 0, "an invalid hire must not post");
  const keyField = document.getElementById("hire-assignment-key")?.parentElement;
  assert.ok(
    keyField?.textContent?.includes("Name the assignment slot this change edits."),
    "the assignment key field must carry its inline error",
  );
});

test("a server refusal renders with its message and saves nothing", async (t) => {
  const fetch = scriptFetch(
    () =>
      new Response(JSON.stringify({ error: "The start date falls in a locked period." }), {
        status: 422,
      }),
  );
  const mounted = await mountHire();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await typeIntoId("hire-reason", "Backfill for parental leave");
  await click(buttonNamed("Record hire"));
  assert.equal(fetch.posts.length, 1, "a valid hire must post once");
  assert.equal(
    (fetch.posts[0]?.body as { reason?: unknown } | undefined)?.reason,
    "Backfill for parental leave",
    "the post must carry the entered reason",
  );
  assert.ok(
    document.body.textContent?.includes("The start date falls in a locked period."),
    "the refusal must render with the server message",
  );
  assert.equal(mounted.saved(), 0, "a refused hire must not complete");
});

test("a valid hire posts once and completes", async (t) => {
  const fetch = scriptFetch(() =>
    Response.json({ employment: { id: "e1" }, request: { id: "r1" } }),
  );
  const mounted = await mountHire();
  t.after(async () => {
    await mounted.done();
    fetch.restore();
  });
  await typeIntoId("hire-reason", "Backfill for parental leave");
  await click(buttonNamed("Record hire"));
  assert.equal(fetch.posts.length, 1, "a valid hire must post once");
  assert.equal(mounted.saved(), 1, "an accepted hire must complete");
});
