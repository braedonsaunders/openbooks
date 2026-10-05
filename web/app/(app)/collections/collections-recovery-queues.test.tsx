import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the dashboard reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/collections",
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
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
      };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return{push(){},replace(){},refresh(){}}};export function useSearchParams(){return new URLSearchParams()};export function usePathname(){return'/collections'}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { RecoveryDashboard } = await import("./RecoveryDashboard");
type DashboardData = import("./view").RecoveryDashboardData;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

function populatedData(reportId: string | null = "report-recovery-1"): DashboardData {
  return {
    window: { from: "2026-07-01", to: "2026-10-01" },
    recoveryReportId: reportId,
    metrics: {
      attempts: 5,
      invoicesWithFailures: 3,
      recoveredInvoices: 2,
      recoveredAmount: "300.00",
      recoveredByCurrency: [{ currency: "USD", amount: "300.00" }],
      recoveryRate: 0.4,
      churnPrevented: 1,
      awaitingAuthentication: 1,
      byDeclineClass: [],
      byProvider: [],
    },
    awaitingAuth: [
      {
        attemptId: "attempt-auth-1",
        invoiceId: "invoice-1",
        invoiceNumber: "INV-AUTH-1",
        customerName: "Auth Co",
        amount: "150.00",
        currency: "USD",
        authUrl: "https://pay.example/auth-1",
        attemptedAt: "2026-09-30T10:00:00Z",
      },
    ],
    expiring: [
      {
        methodId: "method-1",
        partyId: "party-1",
        partyName: "Expire Co",
        provider: "stripe",
        brand: "Visa",
        last4: "4242",
        expiresOn: "2026-10-31",
        currency: "USD",
      },
    ],
    hardStuck: [],
  };
}

function queueTab(label: string): HTMLButtonElement {
  const strip = document.querySelector("nav[aria-label='Needs attention']");
  assert.ok(strip, "the cockpit must offer its queue strip");
  const tab = [...strip.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
  assert.ok(tab, `the strip must offer the ${label} queue`);
  return tab as HTMLButtonElement;
}

function click(button: HTMLButtonElement) {
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function hiddenGuard(text: string): Element | "missing" | null {
  const match = [...document.querySelectorAll("span, a")].find(
    (element) => element.textContent === text,
  );
  if (!match) return "missing";
  return match.closest("div[hidden]");
}

function assertHidden(text: string, message: string) {
  const guard = hiddenGuard(text);
  assert.ok(guard instanceof Element, `${message} (row absent: ${guard === "missing" ? "missing" : "visible"})`);
}

/**
 * Recovery queues replace each other: the strip defaults to authorization
 * while it has work, selecting expiring shows only its rows, and the empty
 * hard-decline queue renders no rows beside the selection.
 */
test("recovery queues replace each other behind counts", async (t) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RecoveryDashboard data={populatedData()} notice={null} />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  // The strip names every queue with its count, even the empty one.
  assert.ok(queueTab("Verify payment"), "the strip names authorization");
  assert.ok(queueTab("Card expiring"), "the strip names expiring cards");
  assert.ok(queueTab("No backup method"), "the strip names hard declines");

  // Authorization has work, so it focuses by default; the card row stays
  // mounted but hidden. The expiring row's span names the whole method, so
  // the guard matches its full text.
  const expiringRow = "Expire Co · Visa •••• 4242";
  assert.equal(hiddenGuard("INV-AUTH-1"), null, "the auth row starts visible");
  assertHidden(expiringRow, "the expiring row starts hidden");

  await act(async () => {
    click(queueTab("Card expiring"));
    await tick();
  });

  assertHidden("INV-AUTH-1", "the auth row hides with its queue");
  assert.equal(hiddenGuard(expiringRow), null, "selecting expiring shows only its rows");

  await act(async () => {
    click(queueTab("No backup method"));
    await tick();
  });

  assertHidden("INV-AUTH-1", "auth stays hidden under hard declines");
  assertHidden(expiringRow, "expiring stays hidden under hard declines");
});

async function renderDashboard(data: DashboardData) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RecoveryDashboard data={data} notice={null} />
      </NextIntlClientProvider>,
    );
    await tick();
    await tick();
  });
  return { host, root };
}

async function unmountDashboard(host: Element, root: { unmount(): void }) {
  await act(async () => {
    root.unmount();
  });
  host.remove();
}

/**
 * The class/provider breakdown lives in the governed report, not beside the
 * queues: with a seeded definition the dashboard links to the tenant's own
 * definition run, and no breakdown list renders underneath.
 */
test("breakdown drills into the governed report definition", async () => {
  const data = populatedData("report-recovery-9");
  data.metrics.byDeclineClass = [
    { declineClass: "hard", failedAttempts: 4, recoveredInvoices: 1, recoveryRate: 0.25 },
  ];
  data.metrics.byProvider = [
    { provider: "stripe", failedAttempts: 4, recoveredInvoices: 1, recoveryRate: 0.25 },
  ];
  const { host, root } = await renderDashboard(data);
  try {
    const drill = host.querySelector("a[href='/reports/custom/run/report-recovery-9']");
    assert.ok(drill, "the dashboard links to the tenant report definition run");
    assert.equal(
      drill.textContent,
      "Open breakdown in Reports",
      "the drill action names its destination",
    );
    assert.ok(
      ![...host.querySelectorAll("span")].some((element) =>
        element.textContent?.includes("failed ·"),
      ),
      "no breakdown list renders beside the drill link",
    );
  } finally {
    await unmountDashboard(host, root);
  }
});

/**
 * Until the governed definition is seeded, exactly one breakdown list stays
 * visible: decline classes render, providers do not stack underneath.
 */
test("missing report definition falls back to one breakdown list", async () => {
  const data = populatedData(null);
  data.metrics.byDeclineClass = [
    { declineClass: "hard", failedAttempts: 4, recoveredInvoices: 1, recoveryRate: 0.25 },
  ];
  data.metrics.byProvider = [
    { provider: "stripe", failedAttempts: 4, recoveredInvoices: 1, recoveryRate: 0.25 },
  ];
  const { host, root } = await renderDashboard(data);
  try {
    assert.ok(
      [...host.querySelectorAll("span")].some((element) =>
        element.textContent?.includes("4 failed · 1 recovered"),
      ),
      "the fallback keeps the decline-class breakdown",
    );
    assert.ok(
      ![...host.querySelectorAll("span")].some((element) =>
        element.textContent === "stripe",
      ),
      "the provider breakdown does not stack under the fallback",
    );
    assert.equal(
      host.querySelector("a[href^='/reports/custom/run/']"),
      null,
      "no drill link renders without a definition",
    );
  } finally {
    await unmountDashboard(host, root);
  }
});
