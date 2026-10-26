import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

// jsdom first: the view reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/close/posting-periods?book=b1" });

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({ navigation: true });
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
        url: "data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { PostingPeriodsView } = await import("./PostingPeriodsView");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Every decided document kind renders its operator label: a preview row
 * for pick lists, shipments or field tickets must never read Unknown. */
test("decided inventory and field kinds render labels, never Unknown value", async () => {
  const kinds = ["pick_list", "shipment", "field_ticket", "purchase_receipt"] as const;
  const rows = kinds.map((kind, index) => ({
    documentId: randomUUID(),
    documentNumber: `DOC-${index + 1}`,
    kind,
    effectiveDate: "2025-12-15",
    periodId: "p1",
    periodName: "Dec 2025",
    blocked: false,
    blockReason: null,
  }));
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/api/close/posting-periods"))
      return Response.json({ ok: true, rows });
    return Response.json({ ok: true, periods: [] });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <PostingPeriodsView
            bookId="b1"
            runId={null}
            canManageBooks={false}
            manageBooksLabel="Manage books"
            canPreview
            initialRows={rows}
            initialError={null}
          />
        </NextIntlClientProvider>,
      );
      await tick();
      await tick();
    });
    const body = document.body.textContent ?? "";
    for (const label of ["Pick List", "Shipment", "Field Ticket", "Goods receipt"]) {
      assert.ok(body.includes(label), `the preview names ${label}`);
    }
    assert.ok(!body.includes("Unknown value"), "no decided kind falls back to Unknown value");
    const assignButton = [...document.querySelectorAll("button")].find((el) =>
      (el.textContent ?? "").trim().startsWith("Assign"),
    );
    assert.ok(assignButton, "the assign action renders with the row count");
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    globalThis.fetch = prior;
  }
});
