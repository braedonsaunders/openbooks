import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-PostgreSQL regression for the payroll settings write boundary. Every
// route mutation must leave its data and audit evidence committed together;
// an audit failure therefore rolls back seeded components, slot mappings, and
// the payroll settings blob as one unit.
const stateKey = Symbol.for("openbooks.payroll-settings-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.payroll-settings-route-test')]
  export async function guardRootSubsidiaryScope() { return null }
  export async function guardPermission() {
    if (!state.authz) return new Response(null, { status: 401 })
    return state.authz
  }
`;
const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.payroll-settings-route-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 401 })
    return state.authz
  }
`;
const mockPayrollOutputs = `
  export const STUB_PASSWORD_TOKENS = []
  export async function stubPasswordPolicy() {
    return { enabled: false, expression: '' }
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (
      specifier === "../../../../lib/authz" &&
      context.parentURL?.includes("payroll/settings")
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (
      specifier === "../../../../lib/feature-gates" &&
      context.parentURL?.includes("payroll/settings")
    ) {
      return { url: "mock:feature-gates", shortCircuit: true };
    }
    if (
      specifier === "../../../../lib/payroll-outputs" &&
      context.parentURL?.includes("payroll/settings")
    ) {
      return { url: "mock:payroll-outputs", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const parentDir = decodeURIComponent(
        new URL(".", context.parentURL).href,
      );
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot !== -1) {
        return nextResolve(
          new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts")
            .href,
          context,
        );
      }
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      const webMarker = context.parentURL?.lastIndexOf("/web/") ?? -1;
      if (webMarker === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(
          `${context.parentURL!.slice(0, webMarker + 1)}engine/${specifier.slice("@openbooks/engine/".length)}`,
        ).href,
        context,
      );
    }
    if (specifier.startsWith("@openbooks/schema/")) {
      const webMarker = context.parentURL?.lastIndexOf("/web/") ?? -1;
      if (webMarker === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(
          `${context.parentURL!.slice(0, webMarker + 1)}schema/${specifier.slice("@openbooks/schema/".length)}`,
        ).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz")
      return { format: "module", source: mockAuthz, shortCircuit: true };
    if (url === "mock:feature-gates")
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    if (url === "mock:payroll-outputs")
      return {
        format: "module",
        source: mockPayrollOutputs,
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?payroll-settings-atomicity-test";
const { PUT, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withBypassContext, withOrgContext } =
  await import("../../../../../engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("../../../../../engine/src/test-fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function authorize(orgId: string, actorId: string): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    allowedSubsidiaryIds: null,
  };
}

function request(method: "PUT" | "POST", body: unknown): Request {
  return new Request("http://openbooks.test/api/payroll/settings", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function payrollState(orgId: string): Promise<{
  settings: Record<string, unknown> | null;
  taxAccount: string | null;
}> {
  return withOrgContext(orgId, async () => {
    const row = await db.execute<{
      settings: Record<string, unknown> | null;
      taxAccount: string | null;
    }>(sql`
      select o.settings->'payroll' as settings,
             (select liability_account_id::text from pay_components
               where org_id = o.id and code = 'TAX' limit 1) as "taxAccount"
        from orgs o where o.id = ${orgId}`);
    return row.rows[0] ?? { settings: null, taxAccount: null };
  });
}

async function installAuditFailure(
  actorId: string,
  tableName: string,
): Promise<() => Promise<void>> {
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const functionName = `payroll_settings_audit_failure_${suffix}`;
  const triggerName = `payroll_settings_audit_failure_trigger_${suffix}`;
  await withBypassContext(() =>
    db.execute(
      sql.raw(`
    create function public."${functionName}"() returns trigger
    language plpgsql as $$
    begin
      if new.table_name = '${tableName}' and new.actor_id = '${actorId}'::uuid then
        raise exception 'forced payroll settings audit failure';
      end if;
      return new;
    end $$;
    create trigger "${triggerName}"
      before insert on audit_log
      for each row execute function public."${functionName}"();
  `),
    ),
  );
  return async () => {
    await withBypassContext(() =>
      db.execute(
        sql.raw(`
      drop trigger if exists "${triggerName}" on audit_log;
      drop function if exists public."${functionName}"();
    `),
      ),
    );
  };
}

function postgresCauseMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause;
  return String(cause?.message ?? error);
}

test(
  "payroll settings and audit evidence roll back together",
  { skip: !DB },
  async () => {
    const fixture = await withBypass(async () => {
      const org = await createScratchOrg();
      return {
        ...org,
        actorId: await createScratchUser(
          org.orgId,
          "Payroll Admin",
          "payroll_admin",
        ),
      };
    });
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);
      removeFailure = await installAuditFailure(fixture.actorId, "orgs");

      await assert.rejects(
        () => PUT(request("PUT", { statutoryHolidayPay: true })),
        (error: unknown) =>
          postgresCauseMessage(error).includes(
            "forced payroll settings audit failure",
          ),
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "slot-account mutations share the payroll settings transaction",
  { skip: !DB },
  async () => {
    const fixture = await withBypass(async () => {
      const org = await createScratchOrg();
      return {
        ...org,
        actorId: await createScratchUser(
          org.orgId,
          "Payroll Admin",
          "payroll_admin",
        ),
      };
    });
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      authorize(fixture.orgId, fixture.actorId);
      const installed = await POST(
        request("POST", { action: "install-pack", country: "CA" }),
      );
      assert.equal(installed.status, 200);
      const before = await payrollState(fixture.orgId);
      removeFailure = await installAuditFailure(
        fixture.actorId,
        "pay_components",
      );

      await assert.rejects(
        () =>
          PUT(
            request("PUT", {
              statutoryHolidayPay: false,
              slotAccounts: { CA: { income_tax: fixture.accounts.ap } },
            }),
          ),
        (error: unknown) =>
          postgresCauseMessage(error).includes(
            "forced payroll settings audit failure",
          ),
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "pack installation rolls back seeded components when audit fails",
  { skip: !DB },
  async () => {
    const fixture = await withBypass(async () => {
      const org = await createScratchOrg();
      return {
        ...org,
        actorId: await createScratchUser(
          org.orgId,
          "Payroll Admin",
          "payroll_admin",
        ),
      };
    });
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);
      removeFailure = await installAuditFailure(fixture.actorId, "orgs");

      await assert.rejects(
        () => POST(request("POST", { action: "install-pack", country: "CA" })),
        (error: unknown) =>
          postgresCauseMessage(error).includes(
            "forced payroll settings audit failure",
          ),
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);
