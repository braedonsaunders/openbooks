import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __relationshipToasts: { kind: string; message: string }[] | undefined;
  var __relationshipRouter: { push(url: string): void; refresh(): void } | undefined;
}

// Customer drawer -> Relationship -> Start tracking answered 200 but the
// empty state and its button stayed until the drawer remounted, so
// operators clicked again and sent duplicate POSTs. The section now
// refreshes its own state from a re-read after the POST (router.refresh()
// never touches its local state), drops a second click landing before
// busy flips, and disables the button for the whole flight.

// jsdom first: the section reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/parties",
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
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__relationshipRouter}export function usePathname(){return '/parties'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__relationshipToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__relationshipToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__relationshipToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
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
const { PartyRelationshipSection } = await import("./PartyRelationshipSection");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const PARTY_ID = "33333333-3333-4333-8333-333333333333";

const OPTIONS = {
  statuses: [{ id: "s1", name: "New", lifecycle_stage: "lead", is_default: true }],
  owners: [],
  territories: [],
  sources: [],
};

const PROFILE = {
  lifecycle_stage: "lead",
  status_id: "s1",
  owner_user_id: null,
  territory_id: null,
  lead_source_id: null,
  industry: null,
  category: null,
  annual_revenue: null,
  employee_count: null,
  qualification_score: null,
  next_action_at: null,
};

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response> | null) {
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

async function mountSection() {
  globalThis.__relationshipToasts = [];
  globalThis.__relationshipRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PartyRelationshipSection partyId={PARTY_ID} canManage />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
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

test("after a successful start the profile renders and Start tracking is gone", async (t) => {
  let gets = 0;
  let posts = 0;
  let releasePost!: (value: unknown) => void;
  const postGate = new Promise((resolve) => {
    releasePost = resolve;
  });
  const restoreFetch = scriptFetch((url, init) => {
    if (url !== `/api/crm/accounts/${PARTY_ID}`) return null;
    if (init?.method === "POST") {
      posts += 1;
      return postGate.then(() =>
        Response.json({ account: { profile: PROFILE, opportunities: [] } }),
      );
    }
    gets += 1;
    const tracked = gets > 1;
    return Response.json({
      account: tracked ? { profile: PROFILE, opportunities: [] } : null,
      options: OPTIONS,
    });
  });
  t.after(restoreFetch);
  const { unmount } = await mountSection();
  t.after(unmount);

  const start = buttonsNamed("Start tracking")[0];
  assert.ok(start, "an untracked party must offer Start tracking");
  // Two clicks landing in the same tick must not send two POSTs: the
  // first flips the re-entry guard synchronously, the second drops.
  await act(async () => {
    start.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    start.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.equal(posts, 1, "only one POST leaves no matter how fast the clicks land");

  // While the POST is in flight the action stays on screen, disabled.
  const inFlight = buttonsNamed("Saving…")[0];
  assert.ok(inFlight, "the empty-state action persists during the flight");
  assert.equal(inFlight.disabled, true, "the button is disabled while the request is in flight");

  await act(async () => {
    releasePost(null);
    await tick();
  });
  await tick();
  await tick();
  await tick();

  assert.equal(posts, 1, "the re-read after success is a GET, never a second POST");
  assert.ok(gets >= 2, "the section re-read its own state after the POST");
  assert.equal(buttonsNamed("Start tracking").length, 0, "Start tracking is gone once the profile renders");
  assert.ok(
    document.body.textContent?.includes("Relationship profile"),
    "the profile renders in place without a drawer remount",
  );
});
