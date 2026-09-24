import assert from "node:assert/strict";
import test from "node:test";

// F5-3: AssistantEntityCards hardcoded its English doc-kind labels
// (KIND_LABELS) while common.transactionTypes carries every one of them
// translated and record-list-view resolves them through the shared
// docTypeMeta primitive. A non-en user must read the same translated kind,
// status, due and reference labels the rest of the app shows.
//
// Only routing/link plumbing is doubled. React, next-intl, the shared
// docTypeMeta primitive and the REAL French catalog run, so hardcoded
// English labels fail every assertion below.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assistant",
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

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){},prefetch(){}}}export function usePathname(){return '/assistant'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
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
const messages = (await import("../../messages/fr")).default;
const { AssistantEntityCards } = await import("./entity-cards");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// A vendor bill (posted, with a reference) and an estimate (draft, due):
// the two shapes that carried hardcoded 'Vendor bill' / 'Estimate',
// an English status, 'Due …' and '· Ref …'.
const output = {
  ok: true,
  data: {
    items: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "vendor_bill",
        documentNumber: "BILL-7",
        referenceNumber: "PO-3",
        documentDate: "2026-08-01",
        status: "posted",
        currency: "USD",
        total: "410.0000",
        party: "Acme",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "estimate",
        documentNumber: "EST-9",
        documentDate: "2026-08-02",
        dueDate: "2026-09-01",
        status: "draft",
        currency: "USD",
        total: "99.0000",
      },
    ],
  },
};

test("F5-3: record cards resolve kind, status, due and reference through the catalog", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
        <AssistantEntityCards name="find_documents" output={output} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => {
    await tick();
  });
  try {
    const text = host.textContent ?? "";
    // Kind labels come from the shared primitive's catalog entries.
    assert.match(text, /Facture fournisseur/);
    assert.match(text, /Devis/);
    // Statuses resolve through common.status, not English literals.
    assert.match(text, /Comptabilisé/);
    assert.match(text, /Brouillon/);
    // Due/reference chrome translates around the data values.
    assert.match(text, /Échéance/);
    assert.match(text, /Réf\./);
    assert.ok(text.includes("PO-3"), "the reference value itself must still render");
    for (const leaked of ["Vendor bill", "Estimate", "posted", "Due ", "Ref "]) {
      assert.ok(!text.includes(leaked), `English ${JSON.stringify(leaked)} must not leak into the French card`);
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
