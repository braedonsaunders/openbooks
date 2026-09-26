import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

declare global {
  var __journalToasts: { kind: string; message: string }[] | undefined;
  var __journalRouter: { push(url: string): void; refresh(): void } | undefined;
}

// journal Memo and Reference sat adjacently with bare labels, so entry
// text landed in the wrong field. Each field now carries its own hint naming
// what belongs there and where it surfaces.

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

test("an editable journal names what belongs in Reference vs Memo", async (t) => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  t.after(() => {
    globalThis.fetch = prior;
  });
  globalThis.__journalToasts = [];
  globalThis.__journalRouter = { push() {}, refresh() {} };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "journal",
    status: "draft",
    document_number: "JE-00012",
    currency: "USD",
    updated_at: TOKEN,
    document_date: "2026-09-17",
    memo: "",
    reference_number: "",
    total: "0.00",
  };
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
            initialMode={"edit" as never}
            canPost
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
  // The drawer portals its panel to the document body, so hints are read
  // off `document`, like the refusal harness reads its alerts.
  const body = document.body.textContent ?? "";
  assert.match(
    body,
    /source document or statement reference/,
    "the Reference field must explain it takes the external number",
  );
  assert.match(
    body,
    /Internal narration stored on the entry/,
    "the Memo field must explain it takes internal narration",
  );
});
