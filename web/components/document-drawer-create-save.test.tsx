import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

declare global {
  var __drawerRouter: { push(url: string): void; refresh(): void } | undefined;
  var __drawerToasts: { kind: string; message: string }[] | undefined;
  var __confirmNext: boolean | undefined;
  var __confirmCalls: unknown[] | undefined;
}

// Saving a NEW invoice gave no success state — the drawer pushed back into
// edit mode with the editing caption and needed a second save before Submit
// appeared, so operators re-entered invoices. A create save now lands on the
// persisted record in view mode with a saved toast, and a possible duplicate
// warns (with the existing number linked) before the write — confirming
// still saves.

// jsdom first: the drawer reads browser globals at render.
const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({ url: "http://localhost:4800/ar/invoices", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ar/invoices'}export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
});

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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__drawerToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__drawerToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function confirmDialog(o){(globalThis.__confirmCalls??=[]).push(o);const next=globalThis.__confirmNext;globalThis.__confirmNext=undefined;return next??true}",
      };
    }
    if (specifier === "@/lib/prompt" || specifier.endsWith("/lib/prompt")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function promptDialog(){return null}",
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
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { ShortcutProvider } = await import("./shortcuts/shortcut-provider");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const PARTY_ID = "33333333-3333-4333-8333-333333333333";

function scriptFetch(handler: (url: string, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, init });
    return handler(url, init) ?? Response.json({});
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

function blankCreateDoc() {
  return {
    id: "",
    kind: "customer_invoice",
    status: "draft",
    document_number: null,
    currency: "USD",
    party_id: PARTY_ID,
    party_name: "Meridian Dynamics",
    updated_at: "",
    document_date: "2026-09-17",
    reference_number: null,
    memo: null,
    subtotal: "100.00",
    tax_total: "0.00",
    total: "100.00",
  };
}

async function mountCreate({
  shortcuts = false,
  persistedStatus,
}: { shortcuts?: boolean; persistedStatus?: "draft" | "approved" } = {}) {
  const pushed: string[] = [];
  globalThis.__drawerRouter = {
    push(url: string) {
      pushed.push(url);
    },
    refresh() {},
  };
  globalThis.__drawerToasts = [];
  globalThis.__confirmCalls = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <OptionalShortcuts enabled={shortcuts}>
            <DocumentDrawer
              payload={{
                doc: persistedStatus
                  ? {
                      ...blankCreateDoc(),
                      id: "11111111-1111-4111-8111-111111111111",
                      status: persistedStatus,
                      document_number: "INV-00001",
                      updated_at: "2026-09-17T12:00:00.000000Z",
                    }
                  : blankCreateDoc(),
                lines: [
                  {
                    id: "",
                    account_id: "income-1",
                    item_id: null,
                    description: "Services",
                    quantity: "1",
                    unit_price: "100",
                    amount: "100.00",
                  },
                ],
              }}
              config={DOC_KINDS["customer_invoice"]!}
              basePath="/ar/invoices"
              parties={[]}
              accounts={[]}
              taxCodes={[]}
              taxGroups={[]}
              cards={[]}
              bankAccounts={[]}
              departments={[]}
              projects={[]}
              locations={[]}
              classes={[]}
              items={[]}
              subsidiaries={[]}
              headerDefs={[]}
              lineDefs={[]}
              canCreate
              canPost
              createMode={persistedStatus === undefined}
              initialMode="edit"
              layout={
                {
                  header: { groups: [] },
                  lines: { columns: [] },
                  actions: [{ key: "submit", visible: true }],
                } as never
              }
            />
          </OptionalShortcuts>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  return { host, root, pushed };
}

function OptionalShortcuts({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return enabled ? <ShortcutProvider>{children}</ShortcutProvider> : <>{children}</>;
}

function saveButton(): HTMLButtonElement {
  const buttons = [...document.querySelectorAll("button")].filter((b) =>
    ["Save", "Save draft"].includes(b.textContent?.trim() ?? ""),
  );
  assert.equal(buttons.length, 1, `exactly one Save button must render (saw ${buttons.length})`);
  return buttons[0] as HTMLButtonElement;
}

test("create save lands on the persisted record in view mode with a saved toast", async (t) => {
  const savedId = randomUUID();
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
      if (url === "/api/documents") {
        return Response.json({
          doc: {
            id: savedId,
            kind: "customer_invoice",
            status: "draft",
            document_number: "INV-00004",
            currency: "USD",
            party_id: PARTY_ID,
            updated_at: "2026-09-17T12:00:01.000000Z",
            document_date: "2026-09-17",
            subtotal: "100.00",
            tax_total: "0.00",
            total: "100.00",
          },
          lines: [],
        });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "create save must POST the collection once",
  );
  assert.deepEqual(
    pushed,
    [`/ar/invoices?doc=${savedId}`],
    "create save must land on the record in view mode, not back in edit mode",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("INV-00004"),
    ),
    "create save must toast the allocated document number",
  );
});

test("a possible duplicate warns with the existing number and cancelling keeps the draft", async (t) => {
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) {
        assert.ok(url.includes("kind=customer_invoice"), `probe names the kind: ${url}`);
        assert.ok(url.includes(`partyId=${PARTY_ID}`), `probe names the party: ${url}`);
        return Response.json({ duplicates: [{ id: "existing-1", documentNumber: "INV-00001" }] });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  globalThis.__confirmNext = false;
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const dialogs = (globalThis.__confirmCalls ?? []) as {
    title?: unknown;
    confirmLabel?: unknown;
  }[];
  assert.equal(dialogs.length, 1, "a match must raise the duplicate confirm");
  assert.equal(dialogs[0]?.title, "Possible duplicate");
  assert.equal(dialogs[0]?.confirmLabel, "Save anyway");
  assert.ok(
    !calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "declining the warning must not write",
  );
});

// A failure before the write — here the duplicate dialog itself blows up —
// must surface exactly like a refused save: a pinned alert plus an error
// toast with the button released. It used to escape as an unhandled
// rejection with the form wedged on Saving, no record and no message.
test("a throwing pre-save dialog pins a visible error and releases Save", async (t) => {
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) {
        return Response.json({ duplicates: [{ id: "existing-1", documentNumber: "INV-00001" }] });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  // Handled here so the rejection cannot fire unhandled while the form
  // mounts; the dialog stub still observes the rejection when Save runs.
  const dialogFailure = Promise.reject(new Error("dialog unavailable"));
  dialogFailure.catch(() => {});
  (globalThis as Record<string, unknown>).__confirmNext = dialogFailure;
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    !calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "the write must never be attempted after the preamble failed",
  );
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "a preamble failure must pin an alert, not only toast");
  assert.match(
    alert.textContent ?? "",
    /Action failed/,
    "with no server reason the alert falls back to localized copy",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some((toast) => toast.kind === "error"),
    "a preamble failure must toast as an error",
  );
  assert.equal(saveButton().disabled, false, "Save must release so the operator can retry");
});

// A non-ok create response pins the server reason the same way an edit
// refusal does — a 500 with no usable body still falls back visibly.
test("a failed create POST pins the server reason and releases Save", async (t) => {
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
      if (url === "/api/documents") {
        return Response.json({ error: "Revenue account is inactive" }, { status: 500 });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  const { host, root, pushed } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "the create must be attempted once",
  );
  assert.deepEqual(pushed, [], "a failed create must not navigate anywhere");
  const alert = document.querySelector('[role="alert"]');
  assert.ok(alert, "a failed create must pin an alert");
  assert.match(
    alert.textContent ?? "",
    /Revenue account is inactive/,
    "the alert must carry the typed reason",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "error" && /Revenue account is inactive/.test(toast.message),
    ),
    "a failed create must toast the typed reason",
  );
  assert.equal(saveButton().disabled, false, "Save must release so the operator can retry");
});

test("edit-save of a draft lands in view mode with Submit and a saved toast", async (t) => {
  const docId = randomUUID();
  const restore = scriptFetch((url, init) => {
    if (url === `/api/documents/${docId}` && init?.method === "PATCH") {
      return Response.json({
        doc: {
          id: docId,
          kind: "customer_invoice",
          status: "draft",
          document_number: "INV-00004",
          currency: "USD",
          party_id: PARTY_ID,
          updated_at: "2026-09-17T12:00:01.000000Z",
          document_date: "2026-09-17",
          subtotal: "100.00",
          tax_total: "0.00",
          total: "100.00",
        },
        lines: [],
      });
    }
    return null;
  }).restore;
  t.after(restore);
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    ...blankCreateDoc(),
    id: docId,
    document_number: null,
    updated_at: "2026-09-17T12:00:00.000000Z",
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc,
              lines: [
                {
                  id: "",
                  account_id: "income-1",
                  item_id: null,
                  description: "Services",
                  quantity: "1",
                  unit_price: "100",
                  amount: "100.00",
                },
              ],
            }}
            config={DOC_KINDS["customer_invoice"]!}
            basePath="/ar/invoices"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            bankAccounts={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            canCreate
            canPost
            initialMode="edit"
            layout={
              {
                header: { groups: [] },
                lines: { columns: [] },
                actions: [{ key: "submit", visible: true }],
              } as never
            }
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const body = document.body.textContent ?? "";
  assert.ok(
    !body.includes("Editing — Save to apply changes."),
    "a saved draft must leave edit mode",
  );
  const actionsMenu = [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Actions"),
  );
  assert.ok(actionsMenu, "Actions menu must render");
  await act(async () => {
    actionsMenu.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.ok(
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent?.trim() === "Submit for approval",
    ),
    "Submit must be available without a second save",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("INV-00004"),
    ),
    "edit save must toast the document number",
  );
});

// A cash-sale edit-save dropped its tenders on landing: resetForm reseeded
// custom.tenders from the returned document, but the writer consumes that
// key into document_tenders and never persists it — so the Tenders tab
// read back empty after every save, and a second save submitted no tenders.
// The seed now comes from the payload's tender table, and the save lands
// in view mode with the saved toast like every other kind.
test("edit-save of a cash sale lands in view mode with tenders intact and a saved toast", async (t) => {
  const docId = randomUUID();
  const tenderTable = [
    {
      position: 1,
      kind: "cash",
      methodLabel: null,
      accountId: "till-1",
      amount: "10.00",
      currency: "USD",
      reference: null,
      externalRef: null,
    },
  ];
  const restore = scriptFetch((url, init) => {
    if (url === `/api/documents/${docId}` && init?.method === "PATCH") {
      return Response.json({
        doc: {
          id: docId,
          kind: "cash_sale",
          status: "draft",
          document_number: "CS-00007",
          currency: "USD",
          party_id: null,
          updated_at: "2026-10-05T12:00:01.000000Z",
          document_date: "2026-10-05",
          subtotal: "10.00",
          tax_total: "0.00",
          total: "10.00",
          custom: {},
        },
        lines: [],
        tenders: tenderTable,
      });
    }
    return null;
  }).restore;
  t.after(restore);
  globalThis.__drawerRouter = { push() {}, refresh() {} };
  globalThis.__drawerToasts = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{
              doc: {
                id: docId,
                kind: "cash_sale",
                status: "draft",
                document_number: null,
                currency: "USD",
                party_id: null,
                updated_at: "2026-10-05T12:00:00.000000Z",
                document_date: "2026-10-05",
                subtotal: "10.00",
                tax_total: "0.00",
                total: "10.00",
                custom: {},
              },
              lines: [],
              tenders: tenderTable,
            }}
            config={DOC_KINDS["cash_sale"]!}
            basePath="/cash-sales"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            bankAccounts={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            canCreate
            canPost
            initialMode="edit"
            layout={
              {
                header: { groups: [] },
                lines: { columns: [] },
                actions: [{ key: "post", visible: true }],
              } as never
            }
            tenderAccounts={[{ id: "till-1", number: "1000", name: "Till" }]}
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  const body = document.body.textContent ?? "";
  assert.ok(
    !body.includes("Editing — Save to apply changes."),
    "a saved cash sale must leave edit mode",
  );
  assert.ok(
    (globalThis.__drawerToasts ?? []).some(
      (toast) => toast.kind === "success" && toast.message.includes("CS-00007"),
    ),
    "cash-sale save must toast the document number",
  );
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the cash-sale record must own one dialog");
  const tab = [...dialog.querySelectorAll("button")].find(
    (node) =>
      node.hasAttribute("aria-pressed") && node.textContent?.trim() === messages.ar.tenders.title,
  );
  assert.ok(tab, "the Tenders tab must stay reachable after save");
  await act(async () => {
    tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  assert.ok(
    (dialog.textContent ?? "").includes(messages.ar.tenders.balanced),
    "the tender table must reseed the editor after save — an emptied editor shows no Balanced badge",
  );
});

test("confirming the duplicate warning saves anyway", async (t) => {
  const savedId = randomUUID();
  const { restore, calls } = (() => {
    const s = scriptFetch((url) => {
      if (url.startsWith("/api/documents/duplicates?")) {
        return Response.json({ duplicates: [{ id: "existing-1", documentNumber: "INV-00001" }] });
      }
      if (url === "/api/documents") {
        return Response.json({
          doc: {
            id: savedId,
            kind: "customer_invoice",
            status: "draft",
            document_number: "INV-00004",
            currency: "USD",
            party_id: PARTY_ID,
            updated_at: "2026-09-17T12:00:01.000000Z",
            document_date: "2026-09-17",
            subtotal: "100.00",
            tax_total: "0.00",
            total: "100.00",
          },
          lines: [],
        });
      }
      return null;
    });
    return { restore: s.restore, calls: s.calls };
  })();
  t.after(restore);
  globalThis.__confirmNext = true;
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await act(async () => {
    saveButton().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
  await tick();
  assert.ok(
    calls.some((call) => call.url === "/api/documents" && call.init?.method === "POST"),
    "confirming the warning must proceed with the save",
  );
});

function savedDocumentResponse(id: string) {
  return Response.json({
    doc: {
      id,
      kind: "customer_invoice",
      status: "draft",
      document_number: "INV-00005",
      currency: "USD",
      party_id: PARTY_ID,
      updated_at: "2026-09-17T12:00:01.000000Z",
      document_date: "2026-09-17",
      subtotal: "100.00",
      tax_total: "0.00",
      total: "100.00",
    },
    lines: [],
  });
}

async function pressChord(code: string) {
  const target = document.querySelector('[role="dialog"]') ?? document.body;
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        code,
        key: code.slice(3).toLowerCase(),
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
  });
  await tick();
  await tick();
}

test("save and new from a create form opens a fresh form that cannot replay the saved record", async (t) => {
  const { restore, calls } = scriptFetch((url) => {
    if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
    if (url === "/api/documents") return savedDocumentResponse(randomUUID());
    return null;
  });
  t.after(restore);
  const { host, root, pushed } = await mountCreate({ shortcuts: true });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressChord("KeyS");
  await pressChord("KeyS");
  const creates = calls.filter(
    (call) => call.url === "/api/documents" && call.init?.method === "POST",
  );
  assert.equal(creates.length, 2, "each Save and new writes exactly one record");
  const keys = creates.map(
    (call) => (call.init?.headers as Record<string, string>)["Idempotency-Key"],
  );
  assert.ok(
    keys[0] && keys[1] && keys[0] !== keys[1],
    "the fresh form carries a new idempotency key, so the second save is a new record",
  );
  assert.deepEqual(pushed, [
    "/ar/invoices?doc=new&kind=customer_invoice&mode=edit",
    "/ar/invoices?doc=new&kind=customer_invoice&mode=edit",
  ]);
});

test("save and close lands on the list instead of the record", async (t) => {
  const { restore } = scriptFetch((url) => {
    if (url.startsWith("/api/documents/duplicates?")) return Response.json({ duplicates: [] });
    if (url === "/api/documents") return savedDocumentResponse(randomUUID());
    return null;
  });
  t.after(restore);
  const { host, root, pushed } = await mountCreate({ shortcuts: true });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  await pressChord("KeyD");
  assert.deepEqual(pushed, ["/ar/invoices"]);
});

for (const status of ["draft", "approved"] as const) {
  test(`save and post follows the server-acknowledged ${status} through its remaining lifecycle`, async (t) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const actions: string[] = [];
    const saved = {
      ...blankCreateDoc(),
      id,
      status,
      document_number: "INV-00001",
      updated_at: "2026-09-17T12:00:01.000000Z",
    };
    const transport = scriptFetch((url, init) => {
      if (url === `/api/documents/${id}` && init?.method === "PATCH")
        return Response.json({ doc: saved, lines: [] });
      if (url === "/api/documents/actions") {
        actions.push(JSON.parse(String(init?.body)).action);
        return Response.json({ ok: true });
      }
      return null;
    });
    t.after(transport.restore);
    const { host, root } = await mountCreate({ persistedStatus: "draft" });
    t.after(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const post = [...document.querySelectorAll("button")].find((button) =>
      ["Post", "Post & new"].includes(button.textContent?.trim() ?? ""),
    );
    assert.ok(post);
    await act(async () => {
      post.click();
      await tick();
      await tick();
    });
    assert.deepEqual(actions, ["post"]);
  });
}

test("save and post remains exclusive while the saved document is being posted", async (t) => {
  const originalFetch = globalThis.fetch;
  const id = "11111111-1111-4111-8111-111111111111";
  let release: ((response: Response) => void) | undefined;
  let creates = 0;
  const actions: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/documents" && init?.method === "POST") {
      creates += 1;
      return Response.json({
        doc: { ...blankCreateDoc(), id, status: "draft", document_number: "INV-00001" },
        lines: [],
      });
    }
    if (url === "/api/documents/actions") {
      const action = JSON.parse(String(init?.body)).action as string;
      actions.push(action);
      if (action === "post")
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return Response.json({ ok: true });
    }
    return Response.json({});
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { host, root } = await mountCreate();
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const post = [...document.querySelectorAll("button")].find((button) =>
    ["Post", "Post & new"].includes(button.textContent?.trim() ?? ""),
  );
  assert.ok(post);
  await act(async () => {
    post.click();
    await tick();
    await tick();
  });
  assert.ok(release);
  assert.equal(post.disabled, true, "the posting command keeps the form busy");
  await act(async () => {
    post.click();
    await tick();
  });
  assert.equal(creates, 1);
  assert.deepEqual(actions, ["post"]);
  await act(async () => {
    release!(Response.json({ ok: true }));
    await tick();
    await tick();
  });
  assert.deepEqual(actions, ["post"]);
});
