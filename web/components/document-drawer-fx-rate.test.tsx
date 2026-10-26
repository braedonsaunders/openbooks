import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// The explicit exchange rate field of a draft invoice or bill: recording a
// rate hands the save the exact pair and posting date shown, a rate recorded
// for another date is flagged before save, and documents already in their
// entity's functional currency show nothing.
await bootJsdomEnvironment({
  url: "http://localhost:4800/ap/bills?doc=b-1",
  matchMediaMatches: false,
});
stubModules({ navigation: { pathname: "/ap/bills" }, intl: false, authz: false, features: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { DocumentFxRateField, storedExplicitFx } = await import("./document-drawer-fx-rate");
const { asDocumentDoc } = await import("./document-drawer-types");

type FieldProps = Parameters<typeof DocumentFxRateField>[0];
const ENTITY = "6f1c2a52-5d7e-4f7a-9a51-2f4b8f0e9c11";
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const bill = (over: Record<string, unknown> = {}) =>
  asDocumentDoc({
    id: "b-1",
    kind: "vendor_bill",
    status: "draft",
    currency: "USD",
    functional_currency: "CAD",
    subsidiary_id: ENTITY,
    document_date: "2026-07-15",
    document_fx_rate_evidence: null,
    ...over,
  });
const recorded = {
  version: 1,
  rate: "1.35",
  source: "Bank confirmation",
  reason: "Contracted conversion for this shipment",
  fromCurrency: "USD",
  toCurrency: "CAD",
  rateDate: "2026-07-15",
  subsidiaryId: ENTITY,
};

async function mount(t: test.TestContext, props: Partial<FieldProps>) {
  document.body.innerHTML = "";
  const changes: unknown[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const field: FieldProps = {
    kind: "vendor_bill",
    doc: bill(),
    editable: true,
    isCreate: false,
    subsidiaryId: ENTITY,
    documentDate: "2026-07-15",
    postingDate: "",
    pending: undefined,
    onChange: (next) => {
      changes.push(next);
    },
    ...props,
  };
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DocumentFxRateField {...field} />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return changes;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  assert.ok(found, `button "${label}" must render`);
  return found as HTMLButtonElement;
}

async function press(label: string) {
  await act(async () => {
    button(label).click();
    await tick();
  });
}

async function type(selector: string, value: string) {
  const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  assert.ok(element, `${selector} must render`);
  // React tracks the native value setter, so set through the element's own prototype.
  const prototype = Object.getPrototypeOf(element) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new element.ownerDocument.defaultView!.Event("input", { bubbles: true }));
    await tick();
  });
}

test("stored evidence is read only in its recorded shape", () => {
  assert.deepEqual(storedExplicitFx(recorded), {
    rate: "1.35",
    source: "Bank confirmation",
    reason: "Contracted conversion for this shipment",
    fromCurrency: "USD",
    toCurrency: "CAD",
    rateDate: "2026-07-15",
  });
  assert.equal(storedExplicitFx(null), null);
  assert.equal(storedExplicitFx({ ...recorded, rate: 1.35 }), null);
});

test("recording a rate hands the save the pair and effective posting date shown", async (t) => {
  const changes = await mount(t, { postingDate: "2026-07-20" });
  assert.match(
    document.body.textContent ?? "",
    /Organization exchange rates at posting \(USD to CAD\)/,
  );
  await press("Record rate");
  assert.match(
    document.body.textContent ?? "",
    /Converts USD to CAD, the functional currency of the document's legal entity, for 2026-07-20/,
  );
  await type("#document-fx-rate", " 1.3525 ");
  await type("#document-fx-source", "Bank confirmation");
  await type("#document-fx-reason", "Contracted conversion for this shipment");
  await press("Apply");
  assert.deepEqual(changes, [
    {
      rate: "1.3525",
      source: "Bank confirmation",
      reason: "Contracted conversion for this shipment",
      fromCurrency: "USD",
      toCurrency: "CAD",
      rateDate: "2026-07-20",
    },
  ]);
});

test("a rate recorded for another posting date is flagged and can be cleared before save", async (t) => {
  const changes = await mount(t, {
    doc: bill({ document_fx_rate_evidence: recorded }),
    documentDate: "2026-07-16",
  });
  const text = document.body.textContent ?? "";
  assert.match(text, /1 USD = 1\.35 CAD on 2026-07-15/);
  assert.match(
    text,
    /recorded for another posting date or legal entity\. Record a rate for 2026-07-16/,
  );
  await press("Use exchange rates");
  assert.deepEqual(changes, [null], "clearing sends null, which removes the recorded evidence");
});

test("a posted bill shows its recorded rate without edit actions", async (t) => {
  await mount(t, {
    doc: bill({ status: "posted", document_fx_rate_evidence: recorded }),
    editable: false,
  });
  assert.match(document.body.textContent ?? "", /1 USD = 1\.35 CAD on 2026-07-15/);
  assert.equal(
    [...document.querySelectorAll("button")].some((b) => /rate/i.test(b.textContent ?? "")),
    false,
  );
});

test("documents in their functional currency, other kinds and unsaved creates show no field", async (t) => {
  for (const props of [
    { doc: bill({ currency: "CAD" }) },
    { kind: "cash_sale" },
    { isCreate: true },
  ] satisfies Partial<FieldProps>[]) {
    await mount(t, props);
    assert.equal(document.body.textContent, "", JSON.stringify(props));
  }
});
