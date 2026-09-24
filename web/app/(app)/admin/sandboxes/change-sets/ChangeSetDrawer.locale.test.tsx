import assert from "node:assert/strict";
import test from "node:test";

// F4-6: the change-set drawer rendered entirely in hardcoded English with
// zero translation hooks. Every label — actions, columns, lifecycle stages,
// status and op badges, capture notes, the item-count line, the empty state,
// the confirm prompt and the promotion refusal reasons (now stable codes
// from the lib, resolved here) — comes from admin.sandboxes.changeSets.

// jsdom first: the drawer reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/admin/sandboxes/change-sets?changeSet=cs1",
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
const { pathToFileURL } = await import("node:url");
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/admin/sandboxes/change-sets'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "../actions") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function transitionChangeSetAction(){return{error:null}}",
      };
    }
    if (specifier === "../../../../../lib/confirm") {
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
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/fr")).default;
const { ChangeSetDrawer } = await import("./ChangeSetDrawer");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const DETAIL = {
  id: "cs1",
  name: "Flags Q3",
  sandboxName: "Bac à sable",
  status: "draft",
  captureComplete: true,
  itemCount: 1,
  capturedCount: 1,
  baseComplete: true,
  createdBy: "creator",
  reviewedBy: null,
  approvedBy: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  reviewedAt: null,
  approvedAt: null,
  appliedAt: null,
  createdName: "Alice",
  reviewedName: null,
  approvedName: null,
  appliedName: null,
  items: [
    {
      id: "item-1",
      tableName: "billing_settings",
      targetId: "r1",
      op: "update" as const,
      payload: { name: "Standard" },
      expectedBefore: null,
      baseCaptured: false,
    },
  ],
};

async function renderDrawer(actorId: string) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <ChangeSetDrawer detail={{ ...DETAIL, items: DETAIL.items.map((item) => ({ ...item })) }} actorId={actorId} />
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

const ENGLISH = [
  "Record review",
  "Record type",
  "Production at capture",
  "Proposed configuration",
  "Recorded actor",
  "Pending",
  "No configuration changes.",
];

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

test("an actionable change set renders French drawer copy", async (t) => {
  const { unmount } = await renderDrawer("reviewer-1");
  t.after(unmount);
  const text = document.body.textContent ?? "";
  for (const expected of [
    "Enregistrer l'examen",
    "Type d'enregistrement",
    "Enregistrement",
    "Modification",
    "Brouillon",
    "1 changement capturé",
    "Examinez chaque enregistrement",
    "Capturé",
    "En attente",
    "Mise à jour",
  ]) {
    assert.ok(text.includes(expected), `the French drawer must render ${JSON.stringify(expected)}`);
  }
  for (const leaked of ENGLISH) {
    assert.ok(!text.includes(leaked), `no English literal may leak into the French drawer: ${leaked}`);
  }

  // Drill into the row: the capture sections translate too.
  const record = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Standard",
  );
  assert.ok(record, "the record link must render for the captured row");
  await click(record);
  await tick();
  const detail = document.body.textContent ?? "";
  for (const expected of [
    "Retour aux modifications capturées",
    "Production au moment de la capture",
    "Instantané de production indisponible",
    "Configuration proposée",
  ]) {
    assert.ok(detail.includes(expected), `the French drill-down must render ${JSON.stringify(expected)}`);
  }
  assert.ok(
    !/Back to captured changes/.test(detail),
    "no English drill-down literal may leak into the French drawer",
  );
});

test("a blocked promotion renders the French segregation reason", async (t) => {
  // The creator cannot review their own capture: no action, just the reason.
  const { unmount } = await renderDrawer("creator");
  t.after(unmount);
  const text = document.body.textContent ?? "";
  assert.match(text, /quatre utilisateurs différents/, "the segregation reason must read French");
  assert.ok(
    !/four different users/.test(text),
    "no English segregation reason may leak into the French drawer",
  );
  assert.ok(
    !/Enregistrer l'examen/.test(text),
    "a blocked promotion must offer no action button",
  );
});
