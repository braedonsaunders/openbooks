import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the workspace reads browser globals at render.
const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({ url: "http://localhost:4800/tax/oss", matchMediaMatches: false, scrollIntoView: false, resizeObserver: false });

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link" || specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children};export function useRouter(){return{push(){},replace(){},refresh(){}}};export function useSearchParams(){return new URLSearchParams()};export function usePathname(){return'/tax/oss'};export function useParams(){return{}}",
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
const messages = (await import("../../../../messages/en")).default;
const { BusinessDateProvider } = await import("../../../../components/business-date-provider");
const { OssConsole } = await import("./OssConsole");

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(calls: string[]): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot>; restore: () => void }> {
  const prior = globalThis.fetch;
  const restore = () => {
    globalThis.fetch = prior;
  };
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/tax/oss-returns?")) {
      return Response.json(
        {
          scheme: "union",
          identificationState: "DE",
          registrationNumber: "DE123456789",
          from: "2026-07-01",
          to: "2026-09-30",
          currency: "USD",
          lines: [{ consumptionCountry: "FR", ratePercent: "20", baseAmount: "100.00", taxAmount: "20.00", kind: "supply", correctionQuarter: null }],
          totalBase: "100.00",
          totalTax: "20.00",
        },
        { status: 200 },
      );
    }
    if (url.startsWith("/api/tax/oss-returns/conflicts")) {
      return Response.json(
        {
          conflicts: [
            {
              documentId: "11111111-1111-1111-1111-111111111111",
              documentNumber: "INV-2041",
              kind: "customer_invoice",
              documentDate: "2026-08-14",
              countries: ["DE", "FR"],
              evidence: [
                { kind: "billing_address", country: "DE" },
                { kind: "ip_country", country: "FR" },
              ],
            },
          ],
        },
        { status: 200 },
      );
    }
    if (url.startsWith("/api/tax/oss-returns/turnover")) {
      return Response.json(
        {
          year: 2026,
          totalEur: "4200.0050",
          threshold: "10000.0000",
          crossed: false,
          translated: [],
          uncoveredCurrencies: [],
        },
        { status: 200 },
      );
    }
    if (url.startsWith("/api/tax/oss-returns/fx-evidence")) {
      return Response.json(
        {
          rows: [{ currency: "USD", rate: "1.0842500000", rateAsOf: "2026-09-30", rateSource: "ECB" }],
        },
        { status: 200 },
      );
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BusinessDateProvider today="2026-08-15"><OssConsole setupHref="/admin/setup/tax-oss-registrations" /></BusinessDateProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) await tick();
  return { host, root, restore };
}

test("oss console shows the evidence-conflict queue with a document remedy link", async () => {
  const calls: string[] = [];
  const { host, root, restore } = await mount(calls);
  try {
    const buttons = Array.from(host.querySelectorAll("button"));
    const prepare = buttons.find((b) => b.textContent === "Prepare return");
    assert.ok(prepare, "expected a Prepare return button");
    await act(async () => {
      prepare.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      for (let i = 0; i < 10; i++) await tick();
    });
    for (let i = 0; i < 10; i++) await tick();
    assert.ok(calls.some((u) => u.startsWith("/api/tax/oss-returns/conflicts")), "expected a conflicts fetch");
    const link = host.querySelector('a[href*="/ar/invoices?doc="]');
    assert.ok(link, "expected a remedy link into the invoice drawer");
    assert.match(host.textContent ?? "", /INV-2041/);
  } finally {
    restore();
    await act(async () => root.unmount());
    host.remove();
  }
});

test("oss console shows the threshold monitor and the fx evidence rate", async () => {
  const calls: string[] = [];
  const { host, root, restore } = await mount(calls);
  try {
    const buttons = Array.from(host.querySelectorAll("button"));
    const prepare = buttons.find((b) => b.textContent === "Prepare return");
    assert.ok(prepare, "expected a Prepare return button");
    await act(async () => {
      prepare.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      for (let i = 0; i < 10; i++) await tick();
    });
    for (let i = 0; i < 10; i++) await tick();
    assert.ok(calls.some((u) => u.startsWith("/api/tax/oss-returns/turnover")), "expected a turnover fetch");
    assert.match(host.textContent ?? "", /4[,.]?200\.01/);
    assert.match(host.textContent ?? "", /1\.0843/);
  } finally {
    restore();
    await act(async () => root.unmount());
    host.remove();
  }
});
