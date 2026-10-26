// The employee drawer's Save compares against the party revision it holds.
// The payroll profile section can write the party row (the worker-compensation
// class lives on the employee role), so the drawer must adopt the post-save
// revision before its own Save. A genuine edit by someone else still refuses.

import assert from "node:assert/strict";
import test from "node:test";

declare global {
  var __payrollTabProps: { onPartyRecordChanged: () => void } | undefined;
}
import { bootJsdomEnvironment } from "../../../testing/jsdom-env";
import { stubModules } from "../../../testing/stub-modules";

await bootJsdomEnvironment({
  url: "http://localhost:4800/parties?mode=edit",
  matchMediaMatches: false,
});

stubModules({
  navigation: {
    source:
      "export function useRouter(){return globalThis.__revisionRouter}" +
      "export function usePathname(){return '/parties'}" +
      "export function useSearchParams(){return new URLSearchParams()}",
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){},info(){}};export function Toaster(){return null}",
  },
});

// The payroll tab, the pay-component list and the bank panel are separate
// editors with their own endpoints; the drawer under test only needs the tab's
// props. The stub records the latest props so the test can fire the section's
// committed-save callback exactly as the real editor does.
const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/PayrollProfileTab")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function PayrollProfileTab(props){globalThis.__payrollTabProps=props;return null}",
      };
    }
    if (specifier.endsWith("/EmployeePayComponents")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function EmployeePayComponents(){return null}",
      };
    }
    if (specifier.endsWith("/PartyBankAccountsPanel")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function BankAccountsPanel(){return null}",
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
const enMessages = (await import("../../../messages/en")).default as Record<string, unknown>;
const { MoneyProvider } = await import("../../../components/money-provider");
const { BusinessDateProvider } = await import("../../../components/business-date-provider");
const { PartyDrawer } = await import("./PartyDrawer");

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const EMPLOYEE_ID = "55555555-5555-4555-8555-555555555555";
const OPENED_AT = "2026-09-17T12:00:00.000000Z";
const SECTION_SAVED_AT = "2026-09-18T09:00:00.000000Z";
const OTHER_EDIT_AT = "2026-09-18T10:00:00.000000Z";
const MAIN_SAVED_AT = "2026-09-18T09:05:00.000000Z";

interface ServerEmployee {
  updatedAt: string;
  workerCompGroupId: string | null;
}

interface PatchRecord {
  status: number;
  body: {
    expectedUpdatedAt?: string;
    roles?: { employee?: { workerCompGroupId?: string | null } };
  };
}

const state: { server: ServerEmployee; patches: PatchRecord[] } = {
  server: { updatedAt: OPENED_AT, workerCompGroupId: "wc-old" },
  patches: [],
};

function employeePayload() {
  return {
    party: {
      id: EMPLOYEE_ID,
      display_name: "Ava Employee",
      legal_name: null,
      short_code: null,
      kind: "person",
      email: null,
      phone: null,
      website: null,
      subsidiary_id: null,
      is_active: true,
      updated_at: state.server.updatedAt,
      custom: null,
      invoicing_preference: null,
    },
    customer: null,
    vendor: null,
    employee: {
      is_active: true,
      employee_number: null,
      job_title: null,
      department_id: null,
      trade_id: null,
      worker_comp_group_id: state.server.workerCompGroupId,
      hired_on: null,
    },
    addresses: [],
    contacts: [],
    bankAccounts: [],
    transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] },
    additionalSubsidiaryIds: [],
  };
}

function handleFetch(url: string, init?: RequestInit): Response | null {
  if (url !== `/api/parties/${EMPLOYEE_ID}`) return null;
  if (init?.method === "PATCH") {
    const body = JSON.parse(String(init.body ?? "{}")) as PatchRecord["body"];
    if (body.expectedUpdatedAt !== state.server.updatedAt) {
      state.patches.push({ status: 409, body });
      return Response.json(
        { error: "this party changed after you opened it; reload and review the latest revision" },
        { status: 409 },
      );
    }
    const nextGroup = body.roles?.employee?.workerCompGroupId;
    state.server = {
      updatedAt: MAIN_SAVED_AT,
      workerCompGroupId: nextGroup === undefined ? state.server.workerCompGroupId : nextGroup,
    };
    state.patches.push({ status: 200, body });
    return Response.json(employeePayload());
  }
  return Response.json(employeePayload());
}

async function mount() {
  state.server = { updatedAt: OPENED_AT, workerCompGroupId: "wc-old" };
  state.patches = [];
  Object.assign(globalThis, {
    __revisionRouter: { push() {}, replace() {}, refresh() {} },
    __payrollTabProps: null,
  });
  const prior = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return handleFetch(url, init) ?? Response.json({});
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
        <MoneyProvider currency="USD">
          <BusinessDateProvider today="2026-09-18">
            <PartyDrawer
              payload={employeePayload() as never}
              paymentTerms={[]}
              departments={[]}
              trades={[]}
              workerCompGroups={[
                { id: "wc-old", name: "Old" },
                { id: "wc-new", name: "New" },
              ]}
              fieldDefs={[]}
              subsidiaries={[]}
              canManage
              canManagePayroll
              payrollEnabled
              role="employee"
              recordType="employee"
              initialMode={"edit" as never}
              initialTab={"payroll" as never}
              closeHref="/entities/employees"
            />
          </BusinessDateProvider>
        </MoneyProvider>
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick(60);
  return {
    cleanup: async () => {
      globalThis.fetch = prior;
      await act(async () => {
        root.unmount();
      });
      host.remove();
      for (const node of [...document.body.children]) node.remove();
    },
  };
}

async function clickSave() {
  const save = enMessages as { common: { actions: { save: string } } };
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === save.common.actions.save,
  ) as HTMLButtonElement | undefined;
  assert.ok(button, "the drawer's Save button must render in edit mode");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(60);
  });
  await tick(60);
}

test("the drawer Save uses the revision a payroll section save produced", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  // The profile save commits: it moves the worker-compensation class and bumps
  // the party revision on the server. The section then reports the commit.
  state.server = { updatedAt: SECTION_SAVED_AT, workerCompGroupId: "wc-new" };
  await act(async () => {
    assert.ok(globalThis.__payrollTabProps);
    globalThis.__payrollTabProps.onPartyRecordChanged();
    await tick(60);
  });
  await clickSave();
  assert.equal(state.patches.length, 1, "the drawer must issue one party save");
  assert.equal(state.patches[0]?.status, 200, "the save must not be refused as a concurrent edit");
  assert.equal(
    state.patches[0]?.body.expectedUpdatedAt,
    SECTION_SAVED_AT,
    "the save must carry the post-section revision",
  );
  assert.equal(
    state.patches[0]?.body.roles?.employee?.workerCompGroupId,
    "wc-new",
    "the untouched select must follow the class the section saved, not revert it",
  );
});

test("a genuine concurrent edit by another user still refuses the drawer Save", async (t) => {
  const { cleanup } = await mount();
  t.after(cleanup);
  state.server = { updatedAt: OTHER_EDIT_AT, workerCompGroupId: "wc-old" };
  await clickSave();
  assert.equal(state.patches.length, 1, "the drawer must issue one party save");
  assert.equal(
    state.patches[0]?.status,
    409,
    "a revision another editor moved must still be refused",
  );
  assert.equal(
    state.patches[0]?.body.expectedUpdatedAt,
    OPENED_AT,
    "the refused save carries the revision from open",
  );
});
