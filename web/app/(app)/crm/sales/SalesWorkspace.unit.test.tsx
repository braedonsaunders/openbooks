import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { bootJsdomEnvironment } from "../../../../testing/jsdom-env";
import { stubModules } from "../../../../testing/stub-modules";
import type { SalesWorkspaceData } from "@openbooks/engine/crm/sales/contracts";
await bootJsdomEnvironment({
  url: "http://localhost/crm/sales",
  matchMediaMatches: false,
});
Object.assign(globalThis, { React });
stubModules({
  navigation: {
    source: `export function usePathname(){return window.location.pathname} export function useSearchParams(){return new URLSearchParams(window.location.search)} export function useRouter(){return {push(){},replace(){},refresh(){}}}`,
  },
});
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { default: messages } = await import("../../../../messages/en");
const { ViewTabsProvider } =
  await import("../../../../components/module-home/navigation-context");
const { MoneyProvider } = await import("../../../../components/money-provider");
const { LOCAL_NAVIGATION_BY_ID } = await import("@openbooks/engine/navigation");
const { SalesWorkspace } = await import("./SalesWorkspace");
const group = LOCAL_NAVIGATION_BY_ID.get("crm-sales")!.tabs.map((tab) => ({
  href: tab.href,
  label: (messages.crm.sales.tabs as Record<string, string>)[
    tab.key.split(".").at(-1)!
  ]!,
}));
const baseline: SalesWorkspaceData = {
  departments: [],
  customerLocations: [],
  customerLocationStats: { total: 0, located: 0 },
  mapTerritories: [],
  reports: {
    quota: "/reports/custom/run/quota",
    evidence: "/reports/custom/run/evidence",
  },
  quotaOptions: [],
  page: "overview",
  rows: [],
  total: 0,
  currentPage: 1,
  perPage: 25,
  employees: [],
  representatives: [],
  teams: [],
  subsidiaries: [],
  currencies: [{ code: "CAD", name: "Canadian dollar" }],
  baseCurrency: "CAD",
  multiCurrency: true,
  mapEnabled: false,
  canManage: true,
  canApprove: false,
  selected: null,
  creating: false,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  summary: [],
  counts: {
    representatives: 2,
    teams: 1,
    territories: 3,
    draftQuotas: 4,
    unattributed: 5,
    undated: 6,
  },
};
async function mount(data: SalesWorkspaceData) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ViewTabsProvider managed groups={[group]}>
            <SalesWorkspace data={data} params={{}} />
          </ViewTabsProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    ),
  );
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
test("all Sales routes use exactly one global subtab switch in the top-right header", async () => {
  for (const tab of group) {
    window.history.replaceState({}, "", tab.href);
    const section = tab.href.split("/").at(-1)!;
    const page = (
      section === "sales" ? "overview" : section
    ) as SalesWorkspaceData["page"];
    const screen = await mount({ ...baseline, page });
    try {
      if (page !== "overview")
        assert.ok(
          [...screen.host.querySelectorAll("button")].some(
            (button) =>
              button.textContent ===
              {
                representatives: "New sales rep",
                teams: "New sales team",
                quotas: "New quota",
                territories: "New territory",
              }[page],
          ),
        );
      assert.equal(
        screen.host.textContent!.includes("No results"),
        false,
        "empty lists show one useful empty state",
      );
      const strips = screen.host.querySelectorAll("[data-subtabs]");
      assert.equal(strips.length, 1, `${page} must have one shared switch`);
      assert.ok(
        strips[0]!.closest("header [data-page-actions]"),
        "Sales navigation belongs in the header action rail",
      );
      assert.deepEqual(
        [...strips[0]!.querySelectorAll("a")].map((a) =>
          a.getAttribute("href"),
        ),
        group.map((t) => t.href),
      );
      assert.equal(
        strips[0]!.querySelector("[aria-current=page]")?.getAttribute("href"),
        tab.href,
      );
      assert.equal(
        screen.host.querySelector("[role=dialog]"),
        null,
        "list records open only through their URL drawer",
      );
    } finally {
      await screen.close();
    }
  }
});
test("native employee rows remain visible without login identities and read-only callers receive no New action", async () => {
  window.history.replaceState({}, "", "/crm/sales/representatives");
  const screen = await mount({
    ...baseline,
    page: "representatives",
    canManage: false,
    total: 1,
    rows: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Employee without login",
        revision: 0,
        subsidiary_id: null,
        is_sales_rep: true,
        employee_number: "EMP-42",
        sales_rep_since: "2020-01-01",
      },
    ],
  });
  try {
    assert.match(screen.host.textContent!, /Employee without login/);
    assert.match(screen.host.textContent!, /EMP-42/);
    assert.equal(
      [...screen.host.querySelectorAll("a")].some((a) =>
        a.getAttribute("href")?.includes("row=new"),
      ),
      false,
    );
  } finally {
    await screen.close();
  }
});

const rep = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Employee without login",
  revision: 0,
  subsidiary_id: "00000000-0000-4000-8000-000000000003",
  is_sales_rep: true,
  employee_number: "EMP-42",
  sales_rep_since: "2020-01-01",
  updated_at: "2026-10-01T00:00:00Z",
  department_name: "Enterprise sales",
  repSummary: { customers: 12, openOpportunities: 5, teams: 2, quotas: 3 },
};
test("representative details use the wide native drawer and Financial Health panels with editable sales details and removal", async () => {
  const screen = await mount({
    ...baseline,
    page: "representatives",
    selected: rep,
    rows: [rep],
    employees: [rep],
    representatives: [rep],
    subsidiaries: [
      {
        id: rep.subsidiary_id,
        name: "Canada",
        subsidiary_id: rep.subsidiary_id,
      },
    ],
  });
  try {
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    assert.match(dialog.className, /max-w-6xl/);
    assert.match(dialog.textContent!, /Assigned customers/);
    assert.match(dialog.textContent!, /Enterprise sales/);
    assert.ok(
      [...dialog.querySelectorAll("button")].some(
        (button) => button.textContent === "Remove sales rep",
      ),
    );
    assert.ok(
      [...dialog.querySelectorAll("button")].some(
        (button) => button.textContent === "Save",
      ),
    );
  } finally {
    await screen.close();
  }
});
test("quota creation offers both a native individual sales rep and a sales team target", async () => {
  const screen = await mount({
    ...baseline,
    page: "quotas",
    creating: true,
    representatives: [rep],
    employees: [rep],
    subsidiaries: [
      {
        id: rep.subsidiary_id,
        name: "Canada",
        subsidiary_id: rep.subsidiary_id,
      },
    ],
    teams: [
      {
        id: "00000000-0000-4000-8000-000000000004",
        name: "Enterprise team",
        subsidiary_id: rep.subsidiary_id,
      },
    ],
  });
  try {
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    const target = [...dialog.querySelectorAll("select")].find((select) =>
      [...select.options].some(
        (option) => option.textContent === "Individual sales rep",
      ),
    )!;
    assert.ok(target);
    assert.ok(
      [...dialog.querySelectorAll("option")].some(
        (option) => option.textContent === rep.name,
      ),
    );
    await act(async () => {
      target.value = "team";
      target.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.ok(
      [...dialog.querySelectorAll("option")].some(
        (option) => option.textContent === "Enterprise team",
      ),
    );
  } finally {
    await screen.close();
  }
});
