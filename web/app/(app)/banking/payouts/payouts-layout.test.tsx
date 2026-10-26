import assert from "node:assert/strict";
import test from "node:test";

const { bootJsdomEnvironment } = await import("../../../../testing/jsdom-env");
await bootJsdomEnvironment({
  url: "http://localhost:4800/banking/payouts",
  matchMediaMatches: false,
});
const route = { query: "subsidiaryId=entity-a", replaced: "" };
Object.assign(globalThis, { __payoutLayoutRoute: route });
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: `const state=globalThis.__payoutLayoutRoute;export function useRouter(){return{replace(url){state.replaced=url;state.query=url.slice(1)},refresh(){}}}export function useSearchParams(){return new URLSearchParams(state.query)}export function usePathname(){return '/banking/payouts'}`,
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../messages/en")).default;
const { MoneyProvider } = await import("../../../../components/money-provider");
const { PayoutsWorkspace } = await import("./sections");
import type { PayoutsWorkspaceProps } from "./sections";

const strings = new Proxy(
  { queueTitle: "Needs review", batchesTitle: "Payout batches", kindLabels: { sale: "Sale" } },
  {
    get(target, key: string) {
      return key in target ? target[key as keyof typeof target] : key;
    },
  },
) as unknown as PayoutsWorkspaceProps["strings"];
const props = {
  canReconcile: false,
  tiles: [],
  queue: [
    {
      lineId: "line-a",
      batchId: "batch-a",
      provider: "Provider",
      externalRef: "Review payout",
      settlementDate: "2026-10-01",
      kind: "sale",
      amount: "10.00 USD",
    },
    {
      lineId: "line-b",
      batchId: "batch-b",
      provider: "Secondary provider",
      externalRef: "Secondary payout",
      settlementDate: "2026-10-02",
      kind: "sale",
      amount: "20.00 USD",
    },
  ],
  batches: [
    {
      id: "batch-a",
      provider: "Provider",
      externalRef: "Batch payout",
      settlementDate: "2026-10-01",
      netAmount: "10.00 USD",
      status: "draft",
      statusLabel: "Draft",
      unmatchedLines: 1,
      tied: false,
      accrued: false,
    },
  ],
  reportHref: "/reports/custom/run/payout-report",
  queueAllHref: "/banking/payouts/unmatched",
  strings,
  emptyTitle: "No payouts",
  emptyDescription: "Import a provider payout to review it.",
} as unknown as PayoutsWorkspaceProps;

async function mount(workspaceProps: PayoutsWorkspaceProps = props) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async () =>
    act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MoneyProvider currency="USD">
            <PayoutsWorkspace {...workspaceProps} />
          </MoneyProvider>
        </NextIntlClientProvider>,
      ),
    );
  await render();
  return {
    host,
    render,
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the payout report link uses its run URL and is hidden when unavailable", async () => {
  route.query = "";
  const view = await mount();
  try {
    const link = [...view.host.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "reportLinkLabel",
    );
    assert.equal(link?.getAttribute("href"), "/reports/custom/run/payout-report");
  } finally {
    await view.close();
  }

  const withoutReport = await mount({ ...props, reportHref: null });
  try {
    assert.ok(
      ![...withoutReport.host.querySelectorAll("a")].some(
        (anchor) => anchor.textContent === "reportLinkLabel",
      ),
    );
  } finally {
    await withoutReport.close();
  }
});

test("a payout detail refresh preserves the server refusal message", async () => {
  const originalFetch = globalThis.fetch;
  let detailReads = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("batchId=")) {
      detailReads += 1;
      if (detailReads > 1) {
        return new Response(
          JSON.stringify({
            error: "The payout batch is closed",
            remedy: "Reopen the batch before matching it.",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          batch: {
            id: "batch-a",
            provider: "Provider",
            externalRef: "Batch payout",
            status: "draft",
            currency: "USD",
            netAmount: "10.00",
            settlementDate: "2026-10-01",
          },
          lines: [],
          tieout: { status: "not_posted" },
          accruals: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "/api/psp/settlements" && init?.method === "POST") {
      return new Response(JSON.stringify({ lines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  let view: Awaited<ReturnType<typeof mount>> | null = null;
  try {
    route.query = "view=batches&payout=batch-a";
    view = await mount({ ...props, canReconcile: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const match = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "matchLabel",
    );
    assert.ok(
      match,
      `the loaded payout detail offers its match action: ${document.body.textContent}`,
    );
    await act(async () => {
      match.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(
      document.body.textContent?.includes(
        "The payout batch is closed — Reopen the batch before matching it.",
      ),
    );
    assert.ok(!document.body.textContent?.includes("loadFailedLabel"));
  } finally {
    if (view) await view.close();
    globalThis.fetch = originalFetch;
  }
});

test("payout review and batches replace each other rather than stacking tables", async () => {
  route.query = "subsidiaryId=entity-a";
  const view = await mount();
  try {
    assert.equal(
      view.host.querySelectorAll("table").length,
      1,
      "the review tab must show only its queue table",
    );
    assert.ok(view.host.textContent?.includes("Review payout"));
    assert.ok(view.host.textContent?.includes("Secondary payout"));
    assert.ok(!view.host.textContent?.includes("Batch payout"));
    const search = view.host.querySelector<HTMLInputElement>('input[aria-label="Search"]');
    assert.ok(search, "the queue uses the shared searchable table");
    assert.ok(
      view.host.querySelector("tbody td.text-right.tabular-nums"),
      "payout amounts align as figures",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "Secondary payout",
      );
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.ok(view.host.textContent?.includes("Secondary payout"));
    assert.ok(
      !view.host.textContent?.includes("Review payout"),
      "search filters the loaded payout queue",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "",
      );
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const batches = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Payout batches",
    );
    assert.ok(batches, "a separate Payout batches tab must remain reachable");
    await act(async () => batches.click());
    assert.equal(
      new URLSearchParams(route.replaced.slice(1)).get("subsidiaryId"),
      "entity-a",
      "changing tabs must retain the legal-entity filter",
    );
    await view.render();
    assert.equal(
      view.host.querySelectorAll("table").length,
      1,
      "the batches tab must replace the queue table",
    );
    assert.ok(view.host.textContent?.includes("Batch payout"));
    assert.ok(!view.host.textContent?.includes("Review payout"));
    route.query = "subsidiaryId=entity-a";
    await view.render();
    assert.ok(
      view.host.textContent?.includes("Review payout"),
      "back navigation must restore the review tab",
    );
  } finally {
    await view.close();
  }
});

test("a payout batches deep link renders only batches and retains the view when opening a record", async () => {
  route.query = "view=batches&subsidiaryId=entity-a";
  const view = await mount();
  try {
    assert.equal(view.host.querySelectorAll("table").length, 1);
    assert.ok(view.host.textContent?.includes("Batch payout"));
    assert.ok(!view.host.textContent?.includes("Review payout"));
    const open = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "openLabel",
    );
    assert.ok(open, "the batch record action must remain reachable");
    await act(async () => open.click());
    const params = new URLSearchParams(route.replaced.slice(1));
    assert.equal(params.get("payout"), "batch-a");
    assert.equal(params.get("view"), "batches");
    assert.equal(params.get("subsidiaryId"), "entity-a");
  } finally {
    await view.close();
  }
});
