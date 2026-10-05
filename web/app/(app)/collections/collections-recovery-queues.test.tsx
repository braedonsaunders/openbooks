import assert from "node:assert/strict";
import test from "node:test";

import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost:4800/collections', matchMediaMatches: false })
const recoveryToasts: [string, ...unknown[]][] = []
Object.assign(globalThis, { __recoveryToasts: recoveryToasts })
stubModules({
  navigation: { pathname: '/collections' },
  extra: {
    sonner: "export const toast={success(...a){globalThis.__recoveryToasts.push(['success',...a])},error(...a){globalThis.__recoveryToasts.push(['error',...a])}}",
    'next/link': "export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}",
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
    canRunReport: true,
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
 * A computed setup refusal must reach the operator: when the server refuses
 * the setup session, the toast carries the server's message and remedy
 * instead of a generic failure.
 */
test("a refused setup link surfaces the server refusal and remedy", async (t) => {
  const refusal = { error: "The issuer refused the setup session", remedy: "Ask the customer for a different card" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 422,
    json: async () => refusal,
  })) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const { host, root } = await renderDashboard(populatedData());
  try {
    const send = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Send update link"),
    );
    assert.ok(send, "the expiring queue offers its remedy");
    recoveryToasts.length = 0;
    await act(async () => {
      send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await tick();
      await tick();
    });
    const errors = recoveryToasts.filter(
      ([tone]) => tone === "error",
    );
    assert.ok(errors.length > 0, "the refusal toasts instead of failing silently");
    assert.ok(
      String(errors[0]?.[1]).includes("issuer refused"),
      "the toast carries the server refusal",
    );
    assert.ok(
      String(errors[0]?.[1]).includes("different card"),
      "the toast carries the server remedy",
    );
  } finally {
    await unmountDashboard(host, root);
  }
});

/**
 * A seeded definition the viewer may not run is the same as unseeded: the
 * drill link would refuse at the runner (reports.read), so the hub remedy
 * shows instead of an action that leads to a refusal.
 */
test("a definition without report permission links to the Reports hub", async () => {
  const data = populatedData("report-recovery-9");
  data.canRunReport = false;
  const { host, root } = await renderDashboard(data);
  try {
    assert.equal(
      host.querySelector("a[href^='/reports/custom/run/']"),
      null,
      "no drill link renders without report permission",
    );
    assert.ok(host.querySelector("a[href='/reports']"), "the hub remedy shows instead");
  } finally {
    await unmountDashboard(host, root);
  }
});

/**
 * Until the governed definition is seeded, no bespoke breakdown list renders:
 * the dashboard names the Reports hub remedy and links there instead of
 * stacking a second analytical list under the operational queue.
 */
test("missing report definition links to the Reports hub with no custom list", async () => {
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
      ![...host.querySelectorAll("span")].some((element) =>
        element.textContent?.includes("failed ·"),
      ),
      "no decline-class list renders without a definition",
    );
    assert.ok(
      ![...host.querySelectorAll("span")].some((element) =>
        element.textContent === "stripe",
      ),
      "no provider list renders without a definition",
    );
    assert.equal(
      host.querySelector("a[href^='/reports/custom/run/']"),
      null,
      "no drill link renders without a definition",
    );
    const hub = host.querySelector("a[href='/reports']");
    assert.ok(hub, "the fallback links to the native Reports hub");
  } finally {
    await unmountDashboard(host, root);
  }
});
