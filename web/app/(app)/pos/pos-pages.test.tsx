import assert from "node:assert/strict";
import test from "node:test";
import React, { isValidElement, type ReactElement, type ReactNode } from "react";
import { stubModules } from "../../../testing/stub-modules";

/**
 * Register pages: the permission and feature gates run on the server before
 * any register data is read, the register's capability flags come from the
 * operator's own permissions, and the session history reads one scoped,
 * counted window. Identity, feature state and the register readers are the
 * scripted boundaries; the pages themselves run unmodified.
 */

type Authz = {
  user: { orgId: string; id: string };
  permissions: string[];
  allowedSubsidiaryIds: Set<string> | null;
};
type Call = { fn: string; args: unknown[] };

declare global {
  var __posAuthz: Authz;
  var __posFeatures: string[];
  var __posCalls: Call[];
  var __posRegisters: Array<Record<string, unknown>>;
  var __posSessions: { rows: Array<Record<string, unknown>>; total: number; hasMore: boolean };
}

const ORG = "019f0000-0000-4000-8000-0000000000a1";
const ENTITY = "019f0000-0000-4000-8000-0000000000b1";
const REGISTER = "019f0000-0000-4000-8000-0000000000c1";
const OTHER_REGISTER = "019f0000-0000-4000-8000-0000000000c2";
const SESSION = "019f0000-0000-4000-8000-0000000000d1";

Object.assign(globalThis, { React });
stubModules({
  navigation: true,
  intl: true,
  authz: `
    export async function getAuthz() { return globalThis.__posAuthz }
    export function can(authz, perm) { return authz.permissions.includes(perm) }
    export async function requirePermission(perm) {
      const authz = globalThis.__posAuthz
      if (!authz.permissions.includes(perm)) throw new Error('REDIRECT:/access-denied?permission=' + perm)
      return authz
    }
  `,
  features: `
    export async function isFeatureEnabled(_orgId, key) { return globalThis.__posFeatures.includes(key) }
    export async function requireFeatureEnabled(_orgId, key) {
      if (!globalThis.__posFeatures.includes(key)) throw new Error('REDIRECT:/feature-required?feature=' + key)
    }
  `,
  extra: {
    "@openbooks/engine/pos": `
      export async function listUsableRegisters(_db, orgId, scope) {
        globalThis.__posCalls.push({ fn: 'listUsableRegisters', args: [orgId, scope] })
        return globalThis.__posRegisters
      }
      export async function listSessions(_db, orgId, filters, scope) {
        globalThis.__posCalls.push({ fn: 'listSessions', args: [orgId, filters, scope] })
        return globalThis.__posSessions
      }
    `,
    "@/lib/money-server": `export async function getMoneyFormatter() { return { money: (value, options) => options.currency + ' ' + value } }`,
  },
});

const { loadPosRegisters, posRegistersSpec } = await import("./view");
const { loadPosRegister, posRegisterSpec } = await import("./[registerId]/view");
const { default: PosSessionsPage } = await import("./sessions/page");
const PosPage = () => loadPosRegisters();
const PosRegisterPage = async ({ params }: { params: Promise<{ registerId: string }> }) =>
  loadPosRegister((await params).registerId);

const scope = new Set([ENTITY]);
function signIn(permissions: string[], features: string[] = ["posRegister"]) {
  globalThis.__posAuthz = {
    user: { orgId: ORG, id: "019f0000-0000-4000-8000-0000000000e1" },
    permissions,
    allowedSubsidiaryIds: scope,
  };
  globalThis.__posFeatures = features;
  globalThis.__posCalls = [];
  globalThis.__posRegisters = [
    {
      id: REGISTER,
      code: "R1",
      name: "Front counter",
      subsidiaryId: ENTITY,
      openSessionId: SESSION,
      openedBy: "Dana Cashier",
    },
  ];
  globalThis.__posSessions = {
    rows: [
      {
        id: SESSION,
        registerId: REGISTER,
        registerCode: "R1",
        registerName: "Front counter",
        sessionNumber: 7,
        status: "closed",
        businessDate: "2026-10-16",
        currency: "CAD",
        openedAt: "2026-10-16 08:00:00+00",
        openedByName: "Dana Cashier",
        closedAt: "2026-10-16 17:00:00+00",
        closedByName: "Lee Manager",
        openingFloatMinor: "2000000",
        expectedCashMinor: "5000000",
        countedCashMinor: "4990000",
        overShortMinor: "-10000",
        saleCount: 12,
        salesTotalMinor: "3000000",
        refundsTotalMinor: "0",
      },
    ],
    total: 31,
    hasMore: true,
  };
}

/** Every element in a server-rendered tree, props included, without rendering client components. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isValidElement(value)) return;
    const element = value as ReactElement<Record<string, unknown>>;
    found.push(element);
    for (const prop of Object.values(element.props)) visit(prop);
  };
  visit(node);
  return found;
}

function byName(node: ReactNode, name: string) {
  return elements(node).filter(
    (element) => typeof element.type === "function" && element.type.name === name,
  );
}

const sessionsSearch = (search: Record<string, string>) => ({
  searchParams: Promise.resolve(search),
});

test("each register page refuses an operator without its permission before reading register data", async () => {
  signIn([]);
  await assert.rejects(PosPage(), /REDIRECT:\/access-denied\?permission=pos\.sell/);
  await assert.rejects(
    PosRegisterPage({ params: Promise.resolve({ registerId: REGISTER }) }),
    /REDIRECT:\/access-denied\?permission=pos\.sell/,
  );
  signIn(["pos.sell"]);
  await assert.rejects(
    PosSessionsPage(sessionsSearch({})),
    /REDIRECT:\/access-denied\?permission=pos\.drawer/,
  );
  assert.deepEqual(globalThis.__posCalls, []);
});

test("each register page explains a disabled register feature before reading register data", async () => {
  signIn(["pos.sell", "pos.drawer"], ["cashSales"]);
  await assert.rejects(PosPage(), /REDIRECT:\/feature-required\?feature=posRegister/);
  await assert.rejects(
    PosRegisterPage({ params: Promise.resolve({ registerId: REGISTER }) }),
    /REDIRECT:\/feature-required\?feature=posRegister/,
  );
  await assert.rejects(
    PosSessionsPage(sessionsSearch({})),
    /REDIRECT:\/feature-required\?feature=posRegister/,
  );
  assert.deepEqual(globalThis.__posCalls, []);
});

test("the picker lists registers in the operator scope and offers only the actions the operator holds", async () => {
  signIn(["pos.sell"]);
  const cashier = await PosPage();
  assert.deepEqual(globalThis.__posCalls, [{ fn: "listUsableRegisters", args: [ORG, scope] }]);
  assert.equal(cashier.canManage, false);
  assert.equal(cashier.canViewSessions, false);
  assert.deepEqual(cashier.registers, [
    {
      id: REGISTER,
      code: "R1",
      name: "Front counter",
      openSessionId: SESSION,
      openedBy: "Dana Cashier",
    },
  ]);

  signIn(["pos.sell", "pos.drawer", "pos.manage"]);
  const manager = await PosPage();
  assert.equal(manager.canManage, true);
  assert.equal(manager.canViewSessions, true);

  // Each header action is bound to the flag the loader derived, so the spec
  // omits an action the operator does not hold.
  const spec = JSON.stringify(posRegistersSpec(manager));
  assert.match(spec, /"pos-register-picker"/);
  assert.match(spec, /"href":"\/pos\/sessions"[^}]*}[^}]*"canViewSessions"/);
  assert.match(spec, /"href":"\/admin\/setup\/pos-registers"[^}]*}[^}]*"canManage"/);
});

test("the register derives refund, override and drawer capability from the operator permissions", async () => {
  signIn(["pos.sell"]);
  const cashier = await PosRegisterPage({ params: Promise.resolve({ registerId: REGISTER }) });
  assert.deepEqual(cashier, {
    registerId: REGISTER,
    canRefund: false,
    canOverride: false,
    canManageDrawer: false,
    canViewSessions: false,
  });

  signIn(["pos.sell", "pos.refund", "pos.override", "pos.drawer"]);
  const supervisor = await PosRegisterPage({ params: Promise.resolve({ registerId: REGISTER }) });
  assert.deepEqual(supervisor, {
    registerId: REGISTER,
    canRefund: true,
    canOverride: true,
    canManageDrawer: true,
    canViewSessions: true,
  });
  const spec = JSON.stringify(posRegisterSpec(supervisor));
  assert.match(spec, /"route":"\/pos\/\[registerId\]"/);
  assert.match(spec, /"pos-register-screen"/);
});

test("a register outside the operator scope or a malformed id is not found", async () => {
  signIn(["pos.sell"]);
  await assert.rejects(
    PosRegisterPage({ params: Promise.resolve({ registerId: OTHER_REGISTER }) }),
    /NOT_FOUND/,
  );
  await assert.rejects(
    PosRegisterPage({ params: Promise.resolve({ registerId: "not-a-register" }) }),
    /NOT_FOUND/,
  );
  assert.deepEqual(
    globalThis.__posCalls.map((call) => call.fn),
    ["listUsableRegisters"],
  );
});

test("session history reads one scoped, counted window with validated filters", async () => {
  signIn(["pos.sell", "pos.drawer"]);
  const page = await PosSessionsPage(
    sessionsSearch({ register: REGISTER, status: "closed", page: "2", perPage: "10" }),
  );
  const list = globalThis.__posCalls.find((call) => call.fn === "listSessions");
  assert.deepEqual(list?.args, [
    ORG,
    { registerId: REGISTER, status: "closed", limit: 10, offset: 10 },
    scope,
  ]);
  const [table] = byName(page, "PagedTable");
  assert.ok(table);
  assert.equal(table.props.source, "pos_sessions");
  assert.equal(table.props.prepared, true);
  assert.deepEqual(table.props.serverWindow, { total: 31, page: 2, perPage: 10 });
  assert.equal(byName(page, "PosSessionHost").length, 1);
  const columns = table.props.columns as Array<{ key: string; cell: (row: unknown) => ReactNode }>;
  const row = globalThis.__posSessions.rows[0];
  const overShort = columns
    .find((column) => column.key === "overShort")!
    .cell(row) as ReactElement<{ variant: string }>;
  assert.equal(overShort.props.variant, "warning");
  assert.equal(columns.find((column) => column.key === "counted")!.cell(row), "CAD 499.0000");

  signIn(["pos.sell", "pos.drawer"]);
  await PosSessionsPage(sessionsSearch({ register: "not-a-register", status: "pending" }));
  const unfiltered = globalThis.__posCalls.find((call) => call.fn === "listSessions");
  assert.deepEqual(unfiltered?.args, [
    ORG,
    { registerId: null, status: null, limit: 25, offset: 0 },
    scope,
  ]);
});
