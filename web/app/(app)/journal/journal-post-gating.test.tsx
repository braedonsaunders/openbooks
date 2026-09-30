// The journal drawer offers Post, Delete, Void (and Edit/Save) only
// with gl.post. The server refuses every one of those mutations without
// the permission, so a drawer that offers them anyway only manufactures
// refusals. Mounts drive the real drawer: without canPost no mutation
// button exists even behind the Actions menu, and a ?mode=edit deep link
// lands read-only instead of an unsavable editor.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

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
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
  },
});

// Confirm/prompt doubles stay suffix-wired: shared components import them
// through several relative spellings plus `@/`, which one exact key cannot name.
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
        url: "data:text/javascript,export async function promptDialog(){return 'duplicate entry'}",
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
const { JournalDrawer } = await import("./JournalDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const TOKEN = "2026-09-17T12:00:00.000000Z";

const BALANCED_LINES = [
  { account_id: "a1", amount: "100.00", description: "leg one", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
  { account_id: "a2", amount: "-100.00", description: "leg two", party_id: "", department_id: "", project_id: "", subsidiary_id: "", custom: {}, extra_dims: {} },
];

function docWith(status: string) {
  return {
    id: randomUUID(),
    kind: "journal",
    status,
    document_number: "JE-00012",
    currency: "USD",
    updated_at: TOKEN,
    document_date: "2026-09-17",
    memo: "accrual",
    total: "0.00",
  };
}

function scriptFetch(postWarnings?: unknown) {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.includes("/api/journals/actions") && postWarnings !== undefined) {
      return Response.json({ ok: true, entryId: "e1", warnings: postWarnings });
    }
    if (url.includes("/api/flows/record-state")) {
      return Response.json({
        approvalState: { status: "none", pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      });
    }
    return Response.json({});
  }) as typeof fetch;
  return () => {
    globalThis.fetch = prior;
  };
}

async function mount(doc: Record<string, unknown>, canPost: boolean, initialMode = "view") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <JournalDrawer
            journal={{ doc, lines: BALANCED_LINES } as never}
            parties={[]}
            accounts={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            initialMode={initialMode as never}
            canPost={canPost}
          />
        </MoneyProvider>
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

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")].filter(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement[];
}

async function openActions() {
  const menu = buttonsNamed("Actions")[0];
  assert.ok(menu, "record actions must live behind the Actions menu");
  await act(async () => {
    menu.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

// The five gating cases below share one mount/open/cleanup head; only the
// status, the permission, and the asserted buttons differ.
async function mountGated(t: TestContext, status: string, canPost: boolean, initialMode = "view", postWarnings?: unknown) {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch(postWarnings);
  t.after(restoreFetch);
  const { unmount } = await mount(docWith(status), canPost, initialMode);
  t.after(unmount);
}

test("a draft without gl.post offers no Edit, Post or Delete", async (t) => {
  await mountGated(t, "draft", false);
  assert.equal(buttonsNamed("Edit").length, 0, "no Edit without gl.post");
  await openActions();
  assert.equal(buttonsNamed("Post").length, 0, "no Post without gl.post");
  assert.equal(buttonsNamed("Delete").length, 0, "no Delete without gl.post");
});

test("edit mode without gl.post offers no Save", async (t) => {
  (globalThis as Record<string, unknown>).__journalRouter = { push() {}, refresh() {} };
  const restoreFetch = scriptFetch();
  t.after(restoreFetch);
  // createMode is the only way to reach the editor without the permission,
  // and the loader never opens it without gl.post — mount it directly to
  // prove the Save button itself is gated, not just the way in.
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <JournalDrawer
            journal={{ doc: { ...docWith("draft"), id: "", document_number: null }, lines: BALANCED_LINES } as never}
            parties={[]}
            accounts={[]}
            departments={[]}
            projects={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            createMode
            canPost={false}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  assert.equal(buttonsNamed("Actions").length, 0, "a read-only new journal exposes no mutation menu");
  assert.equal(buttonsNamed("Save").length, 0, "no Save without gl.post, even in the editor");
});

test("a draft with gl.post keeps Edit, Post and Delete", async (t) => {
  await mountGated(t, "draft", true);
  assert.equal(buttonsNamed("Edit").length, 1, "Edit stays with gl.post");
  await openActions();
  assert.ok(buttonsNamed("Post").length >= 1, "Post stays with gl.post");
  assert.ok(buttonsNamed("Delete").length >= 1, "Delete stays with gl.post");
});

test("an approved journal without gl.post offers no Void", async (t) => {
  await mountGated(t, "approved", false);
  await openActions();
  assert.equal(buttonsNamed("Void").length, 0, "no Void without gl.post");
});

test("an approved journal with gl.post keeps Void", async (t) => {
  await mountGated(t, "approved", true);
  await openActions();
  assert.ok(buttonsNamed("Void").length >= 1, "Void stays with gl.post");
});

test("a ?mode=edit deep link without gl.post lands read-only", async (t) => {
  await mountGated(t, "draft", false, "edit");
  await openActions();
  assert.equal(buttonsNamed("Save").length, 0, "the deep link must not strand the reader in an unsavable editor");
  assert.equal(buttonsNamed("Edit").length, 0, "no Edit to re-enter the editor either");
});
test("posting with a budgetary advisory pins every dimension with its remedy", async (t) => {
  await mountGated(t, "draft", true, "view", [
    { code: "budgetary_control_advisory", overages: [{ scenarioName: "Primary 2026", accountNumber: "5000", accountName: "Program costs", fundCode: "25NP", fundName: "Annual fund", subsidiaryName: "Main Co", departmentName: "Programs", projectName: "Harbor Outreach", locationName: "HQ", className: "Weekend Kitchen", extraDims: { fund: "fund-extra-id", awardYear: "2026" }, available: "75.0000", amountOver: "25.0000" }] },
  ]);
  await openActions();
  const post = buttonsNamed("Post")[0];
  assert.ok(post, "Post stays offered with gl.post");
  await act(async () => {
    post.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const alerts = [...document.querySelectorAll('[role="alert"]')].map((p) => p.textContent ?? "");
  assert.equal(alerts.length, 1, "one pinned advisory per overage");
  assert.ok(alerts[0], "the pinned advisory has text");
  assert.ok(alerts[0].includes("Primary 2026") && alerts[0].includes("HQ") && alerts[0].includes("25.0000"), "the advisory keeps scenario, dimensions, and overage");
  assert.ok(alerts[0].includes("Programs") && alerts[0].includes("Harbor Outreach") && alerts[0].includes("Weekend Kitchen") && alerts[0].includes("awardYear: 2026") && !alerts[0].includes("fund-extra-id"), "every named dimension renders a recognizable label");
  assert.ok(alerts[0].includes("Revise the budget through its approval flow, or link this actual to the named encumbrance."), "the advisory names the complete budget revision or encumbrance remedy");
});
