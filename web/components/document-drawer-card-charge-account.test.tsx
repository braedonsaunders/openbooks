import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// The card-charge drawer names the reconcilable card account the charge posts
// against. The helper guides the choice while none is selected, the selected
// account replaces it, and the "no cards" refusal is reserved for an
// organization without reconcilable card accounts.

const { registerHooks } = await import("node:module");
await bootJsdomEnvironment({
  url: "http://localhost:4800/banking/transactions",
  matchMediaMatches: false,
});

stubModules({
  navigation: {
    source:
      "export function useRouter(){return {push(){},refresh(){},replace(){},back(){},forward(){},prefetch(){}}}export function usePathname(){return '/banking/transactions'}export function useSearchParams(){return new URLSearchParams()}",
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
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
      };
    }
    if (specifier === "@/lib/confirm" || specifier.endsWith("/lib/confirm")) {
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
const messages = (await import("../messages/en")).default;
const { MoneyProvider } = await import("./money-provider");
const { DocumentDrawer } = await import("./document-drawer");
const { DOC_KINDS } = await import("../lib/document-kinds");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const SEGMENTS: never[] = [];
const VISA = { id: randomUUID(), number: "2500", name: "Visa", currency_restriction: null };

async function mountCardCharge({
  controlAccountId,
  cardAccounts,
}: {
  controlAccountId: string | null;
  cardAccounts: Record<string, unknown>[];
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const doc = {
    id: randomUUID(),
    kind: "card_charge",
    status: "draft",
    document_number: "CC-00001",
    currency: "USD",
    party_id: null,
    payment_card_id: null,
    updated_at: "2026-10-01T12:00:00.000000Z",
    document_date: "2026-10-01",
    subsidiary_id: null,
    subtotal: "0.00",
    tax_total: "0.00",
    total: "0.00",
    custom: controlAccountId ? { controlAccountId } : {},
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <DocumentDrawer
            payload={{ doc, lines: [] }}
            config={DOC_KINDS["card_charge"]!}
            basePath="/banking/transactions"
            recordType="card_charge"
            parties={[]}
            accounts={[]}
            taxCodes={[]}
            taxGroups={[]}
            cards={[]}
            cardAccounts={cardAccounts as never}
            bankAccounts={[]}
            departments={[]}
            projects={[]}
            locations={[]}
            classes={[]}
            items={[]}
            subsidiaries={[]}
            headerDefs={[]}
            lineDefs={[]}
            segments={SEGMENTS}
            canCreate
            canPost
            initialMode="edit"
          />
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  return {
    host,
    async done() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const HELPER = messages.banking.drawer.cardAccountHelp;
const NO_ACCOUNTS = messages.banking.drawer.noCardAccounts;

test("the card helper guides an unselected card account and yields once one is selected", async (t) => {
  const unselected = await mountCardCharge({ controlAccountId: null, cardAccounts: [VISA] });
  t.after(unselected.done);
  assert.ok(document.body.textContent?.includes(HELPER), "the helper guides the unselected choice");
  assert.ok(
    !document.body.textContent?.includes(NO_ACCOUNTS),
    "card accounts exist, so no refusal shows",
  );
  assert.doesNotMatch(document.body.textContent ?? "", /No cards on file/);
  await unselected.done();

  const selected = await mountCardCharge({ controlAccountId: VISA.id, cardAccounts: [VISA] });
  t.after(selected.done);
  assert.ok(
    !document.body.textContent?.includes(HELPER),
    "the helper hides once the card account is selected",
  );
  assert.ok(!document.body.textContent?.includes(NO_ACCOUNTS));
});

test("the no-cards refusal appears only when the organization has no reconcilable card accounts", async (t) => {
  const none = await mountCardCharge({ controlAccountId: null, cardAccounts: [] });
  t.after(none.done);
  assert.ok(
    document.body.textContent?.includes(NO_ACCOUNTS),
    "the empty organization is named as such",
  );
  assert.ok(!document.body.textContent?.includes(HELPER), "no account picker, so no picker helper");
});
