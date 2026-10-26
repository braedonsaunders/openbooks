import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __journalToasts: { kind: string; message: string }[] | undefined;
  var __journalRouter:
    { push(url: string): void; replace(url: string): void; refresh(): void } | undefined;
}

// A journal's Save and Post share one revision fence: Post fences on the
// token the save returned, a refused post keeps the draft visible, and the
// header shows what the post reported even while a list read that predates
// the commit still carries the draft. A create that names no journal is
// refused in place instead of closing the drawer.

// jsdom first: the drawer reads browser globals at render.
await bootJsdomEnvironment({ url: "http://localhost:4800/journal", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__journalRouter}" +
      "export function usePathname(){return '/journal'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(m){(globalThis.__journalToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__journalToasts??=[]).push({kind:'error',message:String(m)})},warning(m){(globalThis.__journalToasts??=[]).push({kind:'warning',message:String(m)})},info(m){(globalThis.__journalToasts??=[]).push({kind:'info',message:String(m)})}};export function Toaster(){return null}",
  },
});

const { registerHooks: registerConfirmHooks } = await import("node:module");
registerConfirmHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(){return true}",
      };
    }
    if (specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return 'reason'}",
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
const { MoneyProvider } = await import("../../../components/money-provider");
const { JournalDrawer, revisionIsOlder } = await import("./JournalDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const REVISION_DRAFT = "2026-09-17T12:00:00.000000Z";
const REVISION_SAVED = "2026-09-17T12:00:02.000000Z";
const REVISION_POSTED = "2026-09-17T12:00:05.000000Z";

const BALANCED_LINES = [
  {
    account_id: "a1",
    amount: "100.00",
    description: "leg one",
    party_id: "",
    department_id: "",
    project_id: "",
    subsidiary_id: "",
    custom: {},
    extra_dims: {},
  },
  {
    account_id: "a2",
    amount: "-100.00",
    description: "leg two",
    party_id: "",
    department_id: "",
    project_id: "",
    subsidiary_id: "",
    custom: {},
    extra_dims: {},
  },
];

const DRAFT_DOC = () => ({
  id: randomUUID(),
  kind: "journal",
  status: "draft",
  document_number: "JE-00012",
  currency: "USD",
  updated_at: REVISION_DRAFT,
  document_date: "2026-09-17",
  memo: "accrual",
  total: "0.00",
});

type Responder = (url: string, init?: RequestInit) => Response | Promise<Response> | null;

function installFetch(responder: Responder) {
  const prior = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, init });
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return (await responder(url, init)) ?? Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

function freshGlobals() {
  globalThis.__journalToasts = [];
  globalThis.__journalRouter = { push() {}, replace() {}, refresh() {} };
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

async function mountJournal(
  doc: Record<string, unknown>,
  options: { initialMode?: "edit" | "view"; createMode?: boolean } = {},
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (nextDoc: Record<string, unknown>) => (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <JournalDrawer
          journal={{ doc: nextDoc, lines: options.createMode ? [] : BALANCED_LINES } as never}
          parties={[]}
          accounts={[]}
          departments={[]}
          projects={[]}
          subsidiaries={[]}
          headerDefs={[]}
          lineDefs={[]}
          initialMode={options.initialMode}
          createMode={options.createMode}
          canPost
        />
      </MoneyProvider>
    </NextIntlClientProvider>
  );
  await act(async () => {
    root.render(render(doc));
    await tick();
  });
  await tick();
  await tick();
  return {
    rerender: async (nextDoc: Record<string, unknown>) => {
      await act(async () => {
        root.render(render(nextDoc));
        await tick();
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

test("a post fences on the save's revision and shows Posted even when the list props still carry the draft", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  let postBody: Record<string, unknown> | null = null;
  let posted = false;
  const net = installFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && init?.method === "PATCH") {
      return Response.json({ doc: { ...doc, updated_at: REVISION_SAVED }, lines: BALANCED_LINES });
    }
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      return Response.json({
        doc: {
          ...doc,
          updated_at: posted ? REVISION_POSTED : REVISION_SAVED,
          status: posted ? "posted" : "draft",
        },
        lines: BALANCED_LINES,
      });
    }
    if (url === "/api/journals/actions" && init?.method === "POST") {
      postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted = true;
      return Response.json({ ok: true, entryId: randomUUID(), warnings: [] });
    }
    return null;
  });
  t.after(net.restore);
  const drawer = await mountJournal(doc, { initialMode: "edit" });
  t.after(drawer.unmount);

  await click(buttonsNamed("Save")[0]!);
  await click(buttonsNamed("Actions")[0]!);
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "the saved draft offers Post");
  await click(post);

  assert.equal(
    (postBody as Record<string, unknown> | null)?.expectedUpdatedAt,
    REVISION_SAVED,
    "Post must fence on the revision the save returned",
  );
  assert.match(
    document.body.textContent ?? "",
    /Posted/,
    "the header reports the posted status from the post's own read",
  );
  assert.equal(buttonsNamed("Post").length, 0, "a posted journal no longer offers Post");
});

test("a post refused for a stale revision pins the reason and leaves the draft as it is", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  let postBody: Record<string, unknown> | null = null;
  const net = installFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      return Response.json({ doc, lines: BALANCED_LINES });
    }
    if (url === "/api/journals/actions" && init?.method === "POST") {
      postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json(
        {
          error: "this document changed after you opened it; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    return null;
  });
  t.after(net.restore);
  const drawer = await mountJournal(doc);
  t.after(drawer.unmount);

  await click(buttonsNamed("Actions")[0]!);
  await click(buttonsNamed("Post")[0]!);

  assert.equal(
    (postBody as Record<string, unknown> | null)?.expectedUpdatedAt,
    REVISION_DRAFT,
    "the post fences on the editor's revision",
  );
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "the refused post pins an alert on the record");
  assert.match(alert.textContent ?? "", /changed after you opened it/);
  assert.match(
    document.body.textContent ?? "",
    /Draft/,
    "a refused post leaves the journal a draft",
  );
  assert.doesNotMatch(document.body.textContent ?? "", /\bPosted\b/);
});

test("a save answered without a revision token is refused visibly and keeps the editor open", async (t) => {
  freshGlobals();
  const doc = DRAFT_DOC();
  const net = installFetch((url, init) => {
    if (url === `/api/journals/${doc.id}` && init?.method === "PATCH") {
      return Response.json({ doc: { id: doc.id, status: "draft" }, lines: BALANCED_LINES });
    }
    if (url === `/api/journals/${doc.id}` && (!init?.method || init.method === "GET")) {
      return Response.json({ doc, lines: BALANCED_LINES });
    }
    return null;
  });
  t.after(net.restore);
  const drawer = await mountJournal(doc, { initialMode: "edit" });
  t.after(drawer.unmount);

  await click(buttonsNamed("Save")[0]!);

  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "an unconfirmed save must pin an alert, not fail silently");
  assert.doesNotMatch(
    alert.textContent ?? "",
    /DOCUMENT_REVISION_REQUIRED/,
    "the alert carries operator copy, not the internal code",
  );
  assert.ok(buttonsNamed("Save")[0], "the editor stays open so the operator can retry");
});

test("a new journal the server does not confirm stays in the editor with a visible refusal", async (t) => {
  freshGlobals();
  const pushed: string[] = [];
  const replaced: string[] = [];
  globalThis.__journalRouter = {
    push(url: string) {
      pushed.push(url);
    },
    replace(url: string) {
      replaced.push(url);
    },
    refresh() {},
  };
  const net = installFetch((url, init) => {
    if (url === "/api/journals" && init?.method === "POST")
      return Response.json({}, { status: 201 });
    return null;
  });
  t.after(net.restore);
  const blank = {
    id: "",
    kind: "journal",
    status: "draft",
    document_number: null,
    currency: "USD",
    updated_at: "",
    document_date: "2026-09-17",
    memo: "",
    total: "0.00",
  };
  const drawer = await mountJournal(blank, { createMode: true });
  t.after(drawer.unmount);

  await click(buttonsNamed("Save")[0]!);

  assert.deepEqual([...pushed, ...replaced], [], "an unconfirmed create must not leave the drawer");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "an unconfirmed create pins an alert");
  assert.match(alert.textContent ?? "", /did not confirm the new journal/);
  assert.ok(buttonsNamed("Save")[0], "the form stays in create mode for a retry");
});

test("revision ordering compares counters numerically and timestamps chronologically", () => {
  assert.equal(revisionIsOlder("9", "10"), true, "counter 9 precedes counter 10");
  assert.equal(revisionIsOlder("10", "9"), false, "a text comparison would invert this");
  assert.equal(revisionIsOlder("7", "7"), false, "an equal token is not older");
  assert.equal(
    revisionIsOlder(REVISION_DRAFT, REVISION_POSTED),
    true,
    "timestamps compare chronologically",
  );
  assert.equal(revisionIsOlder(REVISION_POSTED, REVISION_DRAFT), false);
});
