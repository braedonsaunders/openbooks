import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({
  url: "http://localhost:4800/property-management",
  matchMediaMatches: false,
});

Object.assign(globalThis, {
  __propertyTestRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
});
stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__propertyTestRouter}" +
      'export function usePathname(){return "/property-management"}' +
      "export function useSearchParams(){return new URLSearchParams()} ",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    sonner: "export const toast={success(){},error(){}};export function Toaster(){return null}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../messages/en")).default;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { PropertyManagementWorkspace } = await import("./PropertyManagementWorkspace");
const { defaultFormLayout } = await import("@openbooks/customization");

test("renders the server-loaded portfolio without fetching it again after mount", async (t) => {
  let fetchCount = 0;
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return Response.json({});
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const rootHandle = createRoot(host);
  t.after(async () => {
    await act(async () => rootHandle.unmount());
    host.remove();
    for (const node of [...document.body.children]) node.remove();
  });

  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-01">
            <PropertyManagementWorkspace
              workspace={{
                properties: [
                  {
                    id: "property-1",
                    code: "NORTH",
                    name: "North Plaza",
                    propertyType: "commercial",
                    status: "active",
                    currency: "USD",
                    address: null,
                    custom: null,
                    subsidiaryId: "entity-1",
                    subsidiaryName: "North America",
                    locationId: null,
                    locationName: null,
                    fixedAssetId: null,
                    rentIncomeAccountId: "income-1",
                    camIncomeAccountId: null,
                    depositLiabilityAccountId: null,
                    defaultBankAccountId: null,
                    unitCount: 0,
                    occupiedUnits: 0,
                  },
                ],
                units: [],
                leases: [],
                charges: [],
                escalations: [],
                schedules: [],
                scheduleTotal: 0,
                schedulesTruncated: false,
                scheduleCountsByLease: [],
                overdueAsOf: "2026-09-01",
                overdueTotal: "0",
                overdueByLease: [],
                overdueInvoices: [],
                deposits: [],
                camPools: [],
                camAllocations: [],
              }}
              initialTab="properties"
              options={{
                subsidiaries: [],
                locations: [],
                tenants: [],
                incomeAccounts: [],
                expenseAccounts: [],
                liabilityAccounts: [],
                bankAccounts: [],
                assets: [],
                openInvoices: [],
                taxCodes: [],
              }}
              permissions={{
                manage: false,
                bill: false,
                account: false,
                bulk: false,
                customize: false,
              }}
              customization={{
                layout: defaultFormLayout("property"),
                forms: [],
                currentFormId: null,
                fieldDefs: [],
                listView: { columns: [{ key: "name", visible: true }] } as never,
              }}
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
  });

  assert.match(host.textContent ?? "", /North Plaza/);
  assert.equal(fetchCount, 0);
});
