import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __relationshipToasts: { kind: string; message: string }[] | undefined;
  var __relationshipRouter: { push(url: string): void; refresh(): void } | undefined;
}

// Customer drawer -> Relationship -> Start tracking answered 200 but the
// empty state and its button stayed until the drawer remounted, so
// operators clicked again and sent duplicate POSTs. The section now
// refreshes its own state from a re-read after the POST (router.refresh
// never touches its local state), drops a second click landing before
// busy flips, and disables the button for the whole flight.

// jsdom first: the section reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/parties", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__relationshipRouter}" +
      "export function usePathname(){return '/parties'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__relationshipToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__relationshipToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__relationshipToasts??=[]).push({kind:'warning',message:String(m)})}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { PartyRelationshipSection } = await import("./PartyRelationshipSection");
const { RecordSaveContext, useRecordSaveRegistry } = await import("../../../components/record-save-participants");

type Registry = ReturnType<typeof useRecordSaveRegistry>;
let recordSave: Registry | null = null;

/** The record drawer's side of the contract: one registry, one Save. */
function RecordHost({ children }: { children: React.ReactNode }) {
  const registry = useRecordSaveRegistry(true);
  recordSave = registry;
  return <RecordSaveContext.Provider value={registry.context}>{children}</RecordSaveContext.Provider>;
}

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
  // The read surfaces the revision token as updated_at: every save
  // must echo it back as expectedUpdatedAt.
  updated_at: "2026-09-17T12:00:00.000000Z",
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

async function mountSection(editable = false) {
  globalThis.__relationshipToasts = [];
  globalThis.__relationshipRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <RecordHost>
          <PartyRelationshipSection partyId={PARTY_ID} canManage editable={editable} />
        </RecordHost>
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

// The relationship PATCH carries the revision token the read
// surfaced as profile.updated_at — the same expectedUpdatedAt contract as
// the main party and bank-account saves — so a second tab holding older
// fields 409s instead of silently replacing them.
test("a relationship save carries the read revision as its concurrency token", async (t) => {
  const patches: { url: string; init?: RequestInit }[] = [];
  const restoreFetch = scriptFetch((url, init) => {
    if (url !== `/api/crm/accounts/${PARTY_ID}`) return null;
    if (init?.method === "PATCH") {
      patches.push({ url, init });
      return Response.json({ account: { profile: PROFILE, opportunities: [] } });
    }
    return Response.json({
      account: { profile: PROFILE, opportunities: [] },
      options: OPTIONS,
    });
  });
  t.after(restoreFetch);
  const { unmount } = await mountSection(true);
  t.after(unmount);
  // The industry field is the first free-text input in the form grid.
  const industry = [...document.querySelectorAll("input")].find(
    (el) => (el as HTMLInputElement).type === "text",
  ) as HTMLInputElement | undefined;
  assert.ok(industry, "the industry input must render");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(industry!, "Software");
    industry!.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.equal(recordSave?.dirty, true, "the typed edit marks the record dirty");
  await act(async () => {
    await recordSave!.saveAll();
    await tick();
  });
  await tick();
  assert.equal(patches.length, 1, "the record's Save is exactly one PATCH");
  const body = JSON.parse(String(patches[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(
    body.expectedUpdatedAt,
    PROFILE.updated_at,
    "the PATCH must echo the read revision verbatim",
  );
  assert.equal(body.industry, "Software");
});

const PROFILE_RESPONSE = () => Response.json({ account: { profile: PROFILE, opportunities: [] }, options: OPTIONS });

test("outside edit mode the relationship reads as values with no controls and no Save", async (t) => {
  const restoreFetch = scriptFetch((url) => (url === `/api/crm/accounts/${PARTY_ID}` ? PROFILE_RESPONSE() : null));
  t.after(restoreFetch);
  const { unmount } = await mountSection(false);
  t.after(unmount);
  const section = [...document.querySelectorAll("section")].find((element) => element.textContent?.includes("Relationship profile"));
  assert.ok(section, "the profile renders");
  assert.equal(section.querySelectorAll("input, select, textarea").length, 0, "view mode renders no editable controls");
  assert.ok(section.querySelector("[data-relationship-read-only]"), "values render read-only");
  assert.ok(section.textContent?.includes("New"), "the stored status reads as a value");
  assert.equal(buttonsNamed("Save").length, 0, "the section never carries its own Save");
});

test("in edit mode the relationship edits through the record and still has no Save of its own", async (t) => {
  const restoreFetch = scriptFetch((url) => (url === `/api/crm/accounts/${PARTY_ID}` ? PROFILE_RESPONSE() : null));
  t.after(restoreFetch);
  const { unmount } = await mountSection(true);
  t.after(unmount);
  const section = [...document.querySelectorAll("section")].find((element) => element.textContent?.includes("Relationship profile"));
  assert.ok(section && section.querySelectorAll("select").length > 0, "edit mode offers the controls");
  assert.equal(buttonsNamed("Save").length, 0, "the record's single Save persists the section");
  assert.equal(recordSave?.dirty, false, "untouched fields leave the record clean");
});
