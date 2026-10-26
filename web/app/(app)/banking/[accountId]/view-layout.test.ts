import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: true,
  intl: 'export async function getTranslations(){return key=>key}export async function getLocale(){return "en"}',
  authz:
    "export async function requirePermission(){}export function can(){return true}export function subsidiaryScopeAllows(){return true}",
  extra: {
    "server-only": "export {}",
    "drizzle-orm": "export function sql(strings,...values){return {strings,values}}",
    "@openbooks/engine/platform/db":
      'export const db={execute(){throw new Error("page loader was not called")}}',
    "@openbooks/engine/platform/business-date/module":
      'export async function businessTimeZone(){return "UTC"}',
    "@openbooks/engine/banking/banking":
      "export function listAccountStatements(){}export function reconciliationBookId(){}export function reconciliationStalenessSummaries(){}",
    "../../../../lib/banking-accounts": "export function bankAccount(){}",
    "@/lib/money-server": "export function getMoneyFormatter(){}",
  },
});

const { bankingAccountSpec } = await import("./view");

function collect(
  source: unknown,
  found: Record<string, Record<string, unknown>[]>,
  seen = new Set<object>(),
) {
  if (!source || typeof source !== "object" || seen.has(source)) return;
  seen.add(source);
  if (Array.isArray(source)) {
    for (const item of source) collect(item, found, seen);
    return;
  }
  const record = source as Record<string, unknown>;
  if (typeof record.widget === "string") (found[record.widget] ??= []).push(record);
  for (const value of Object.values(record)) collect(value, found, seen);
}

function makeSpec(activeTab: "statements" | "reconciliations") {
  const currentParams = {
    stmtQ: "opening balance",
    stmtPage: "2",
    reconStatus: "balanced",
    statement: "statement-1",
  };
  const spec = bankingAccountSpec({
    basePath: "/banking/account-1",
    currentParams,
    accountId: "account-1",
    activeTab,
    canReconcile: true,
    openReconciliationId: null,
    glBalance: "0",
    accountCurrency: "USD",
    statementsTitle: "Statements",
    reconciliationsTitle: "Reconciliations",
    stmtIsEmpty: false,
    reconIsEmpty: false,
  } as unknown as Parameters<typeof bankingAccountSpec>[0]);
  const found: Record<string, Record<string, unknown>[]> = {};
  collect(spec, found);
  return { found, currentParams };
}

test("bank account tabs replace the active server list and preserve list and drawer URLs", () => {
  for (const [tab, source] of [
    ["statements", "bank_account_statements"],
    ["reconciliations", "bank_account_reconciliations"],
  ] as const) {
    const { found, currentParams } = makeSpec(tab);
    const lists = found["registered-record-list"] ?? [];
    assert.equal(lists.length, 1, `${tab} view exposes one independent list`);
    const list = lists[0];
    assert.ok(list);
    assert.equal((list.props as Record<string, unknown>).source, source);
    const tabsBlock = found["module-home-tabs"]?.[0];
    assert.ok(tabsBlock);
    const tabs = (tabsBlock.props as Record<string, unknown>).tabs as Array<{
      href: string;
      active: boolean;
    }>;
    assert.equal(tabs.find((entry) => entry.active)?.href.includes(`tab=${tab}`), true);
    const other = tabs.find((entry) => !entry.active)!;
    const params = new URLSearchParams(other.href.split("?")[1]);
    for (const [key, value] of Object.entries(currentParams)) assert.equal(params.get(key), value);
  }
});
