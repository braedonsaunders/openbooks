import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// The party, report and global drawers all open through this client. Their
// document drawer is the shared one; this test replaces only that shell with a
// stub that shows its afterContent, so what is exercised is the mount: a posted
// credit memo passes its credit-application control into the drawer, and the
// panel reads its own settlement state.
await bootJsdomEnvironment({ url: "http://localhost:4800/parties", matchMediaMatches: false });

stubModules({
  navigation: {
    source:
      'export function useRouter(){return {push(){},refresh(){},replace(){},back(){},prefetch(){}}}export function usePathname(){return "/parties"}export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./document-drawer") {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function DocumentDrawer(p){return globalThis.React.createElement("div",{"data-testid":"document-drawer"},p.afterContent)}',
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}",
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
const { BusinessDateProvider } = await import("./business-date-provider");
const { RelatedTransactionDrawerClient } = await import("./related-transaction-drawer-client");

type ClientData = Parameters<typeof RelatedTransactionDrawerClient>[0]["data"];

const DOC = "00000000-0000-4000-8000-0000000000d1";
const PARTY = "00000000-0000-4000-8000-0000000000d2";
const CREDIT_LINE = "00000000-0000-4000-8000-0000000000d3";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function scriptFetch() {
  const requested: string[] = [];
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    requested.push(url);
    return Response.json({
      state: {
        lineId: CREDIT_LINE,
        amount: "250.0000",
        applied: "0.0000",
        open: "250.0000",
        currency: "USD",
        settlements: [],
      },
    });
  }) as typeof fetch;
  return {
    requested,
    restore: () => {
      globalThis.fetch = prior;
    },
  };
}

async function mount(data: ClientData) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-10-11">
            <RelatedTransactionDrawerClient data={data} />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  return { host, root };
}

function documentData(creditApplications?: {
  documentId: string;
  side: "ap" | "ar";
  partyId: string | null;
  canApply: boolean;
}): ClientData {
  return {
    type: "document",
    props: { creditApplications, config: {}, payload: {} },
  } as unknown as ClientData;
}

test("a posted credit memo opened from a party or report drawer shows the apply control", async () => {
  const net = scriptFetch();
  try {
    const { host, root } = await mount(
      documentData({ documentId: DOC, side: "ar", partyId: PARTY, canApply: true }),
    );
    assert.ok(host.querySelector('[data-testid="document-drawer"]'), "the document drawer renders");
    assert.ok(
      net.requested.some(
        (url) => url.includes("/api/payments/credit-applications?side=ar") && url.includes(DOC),
      ),
      "the panel reads the credit's own settlement state",
    );
    assert.match(host.textContent ?? "", /Apply to open items/);
    await act(async () => {
      root.unmount();
    });
  } finally {
    net.restore();
  }
});

test("a drawer for a document that is not a credit carries no credit panel", async () => {
  const net = scriptFetch();
  try {
    const { host, root } = await mount(documentData());
    assert.equal(net.requested.length, 0, "no credit-application read without a credit");
    assert.doesNotMatch(host.textContent ?? "", /Apply to open items/);
    await act(async () => {
      root.unmount();
    });
  } finally {
    net.restore();
  }
});
