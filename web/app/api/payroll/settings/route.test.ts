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
    allowedSubsidiaryIds: ReadonlySet<string> | null;
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
const { GET, PUT, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypass, withBypassContext, withOrgContext } =
  await import("../../../../../engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("../../../../../engine/src/testing/fixtures.ts");
const { PAYROLL_COUNTRY_PACKS, remittanceScheduleForFrequencyKey } =
  await import("../../../../../engine/src/payroll/packs.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function authorize(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    allowedSubsidiaryIds,
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

test(
  "concurrent payroll setting saves preserve disjoint fields",
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
    try {
      authorize(fixture.orgId, fixture.actorId);
      const responses = await Promise.all([
        PUT(request("PUT", { statutoryHolidayPay: true })),
        PUT(request("PUT", { eftFallbackToCheque: false })),
      ]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
      );
      assert.deepEqual((await payrollState(fixture.orgId)).settings, {
        statutoryHolidayPay: true,
        eftFallbackToCheque: false,
      });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "payroll account and remittance IDs must belong to active local records",
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
    const foreign = await withBypass(() => createScratchOrg());
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);

      const foreignAccount = await PUT(
        request("PUT", { netPayAccountId: foreign.accounts.ap }),
      );
      assert.equal(foreignAccount.status, 422);
      assert.deepEqual(await payrollState(fixture.orgId), before);

      const missingVendor = await PUT(
        request("PUT", { craRemittancePartyId: randomUUID() }),
      );
      assert.equal(missingVendor.status, 422);
      assert.deepEqual(await payrollState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "destination remittance frequencies validate against their own schedule",
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
    try {
      authorize(fixture.orgId, fixture.actorId);

      const accepted = await PUT(
        request("PUT", { rqRemittanceFrequency: "twice_monthly" }),
      );
      assert.equal(accepted.status, 200);
      assert.equal(
        (await payrollState(fixture.orgId)).settings?.rqRemittanceFrequency,
        "twice_monthly",
      );

      const before = await payrollState(fixture.orgId);
      // Not an RQ frequency at all.
      const unknown = await PUT(
        request("PUT", { rqRemittanceFrequency: "weekly" }),
      );
      assert.equal(unknown.status, 422);
      // A CRA remitter type is never a valid RQ frequency and vice versa.
      const crossAgency = await PUT(
        request("PUT", { rqRemittanceFrequency: "accelerated_2" }),
      );
      assert.equal(crossAgency.status, 422);
      const mistyped = await PUT(
        request("PUT", { rqRemittanceFrequency: 3 }),
      );
      assert.equal(mistyped.status, 422);
      assert.deepEqual(await payrollState(fixture.orgId), before);

      // Null clears back to the schedule default.
      const cleared = await PUT(
        request("PUT", { rqRemittanceFrequency: null }),
      );
      assert.equal(cleared.status, 200);
      assert.equal(
        (await payrollState(fixture.orgId)).settings?.rqRemittanceFrequency,
        null,
      );

      // The CRA schedule validates against its own bands: a CRA remitter type
      // is accepted on the CRA key and refused on the RQ key (and vice versa).
      const craAccepted = await PUT(
        request("PUT", { craRemittanceFrequency: "accelerated_2" }),
      );
      assert.equal(craAccepted.status, 200);
      assert.equal(
        (await payrollState(fixture.orgId)).settings?.craRemittanceFrequency,
        "accelerated_2",
      );
      const craCrossAgency = await PUT(
        request("PUT", { craRemittanceFrequency: "twice_monthly" }),
      );
      assert.equal(craCrossAgency.status, 422);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "changing a statutory payable mapping returns a typed warning",
  { skip: !DB },
  async () => {
    const fixture = await withBypass(async () => {
      const org = await createScratchOrg();
      const wsib = randomUUID();
      await db.execute(
        sql`insert into accounts(id,org_id,number,name,type,is_active) values(${wsib},${org.orgId},'2320','WSIB Payable','liability_current_other',true)`,
      );
      return {
        ...org,
        wsib,
        actorId: await createScratchUser(
          org.orgId,
          "Payroll Admin",
          "payroll_admin",
        ),
      };
    });
    try {
      authorize(fixture.orgId, fixture.actorId);
      // Pointing EI payable at a new account is the risk event: the API
      // still accepts it, but must carry a typed warning.
      const changed = await PUT(
        request("PUT", { eiPayableAccountId: fixture.wsib }),
      );
      assert.equal(changed.status, 200);
      const changedBody = (await changed.json()) as {
        ok: boolean;
        warnings?: Array<{ code: string; key: string }>;
      };
      assert.equal(changedBody.ok, true);
      const warnings = changedBody.warnings ?? [];
      assert.ok(
        warnings.some(
          (warning) =>
            warning.code === "statutory_payable_mapping_changed" &&
            warning.key === "eiPayableAccountId",
        ),
        "statutory mapping change carries a typed warning",
      );
      // Re-saving the identical mapping is steady state: no warning.
      const steady = await PUT(
        request("PUT", { eiPayableAccountId: fixture.wsib }),
      );
      assert.equal(steady.status, 200);
      assert.deepEqual(
        ((await steady.json()) as { warnings?: unknown[] }).warnings ?? [],
        [],
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

// Collapsed-refusal splits (queue item 28, batch 2). Every refusal below
// names the cause, the value received, and a remedy that exists; statuses
// and accept/refuse sets are unchanged from the single-sentence refusals.

async function refusalOf(
  response: Response,
): Promise<{ status: number; error: string }> {
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: String(body.error ?? "") };
}

async function scratchPayrollOrg(): Promise<{
  orgId: string;
  actorId: string;
  accounts: Record<string, string>;
  vendorId: string;
}> {
  return withBypass(async () => {
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
}

test(
  "payroll account settings refuse by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);

      const mistyped = await refusalOf(
        await PUT(request("PUT", { netPayAccountId: 42 })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid netPayAccountId")
          && mistyped.error.includes("must be an account id")
          && mistyped.error.includes('"42"')
          && mistyped.error.includes("Payroll setup → Accounts"),
        `non-string account refuses by cause: ${mistyped.error}`,
      );

      const malformed = await refusalOf(
        await PUT(request("PUT", { netPayAccountId: "not-an-id" })),
      );
      assert.equal(malformed.status, 422);
      assert.ok(
        malformed.error.includes("invalid netPayAccountId")
          && malformed.error.includes('"not-an-id" is not an account id'),
        `non-uuid account refuses by cause: ${malformed.error}`,
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);

      const accepted = await PUT(
        request("PUT", {
          netPayAccountId: fixture.accounts.ap,
          wageExpenseAccountId: fixture.accounts.cogs,
        }),
      );
      assert.equal(accepted.status, 200);
      const stored = (await payrollState(fixture.orgId)).settings ?? {};
      assert.equal(stored.netPayAccountId, fixture.accounts.ap);
      assert.equal(stored.wageExpenseAccountId, fixture.accounts.cogs);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "remittance vendor settings refuse by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);

      const mistyped = await refusalOf(
        await PUT(request("PUT", { craRemittancePartyId: 7 })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid craRemittancePartyId")
          && mistyped.error.includes("must be a vendor id")
          && mistyped.error.includes('"7"')
          && mistyped.error.includes("active vendor in this organization"),
        `non-string vendor refuses by cause: ${mistyped.error}`,
      );

      const malformed = await refusalOf(
        await PUT(request("PUT", { craRemittancePartyId: "nope" })),
      );
      assert.equal(malformed.status, 422);
      assert.ok(
        malformed.error.includes("invalid craRemittancePartyId")
          && malformed.error.includes('"nope" is not a vendor id'),
        `non-uuid vendor refuses by cause: ${malformed.error}`,
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);

      await withBypass(() =>
        db.execute(
          sql`insert into vendor_roles (org_id, party_id, is_active) values (${fixture.orgId}, ${fixture.vendorId}, true)`,
        ),
      );
      const accepted = await PUT(
        request("PUT", { craRemittancePartyId: fixture.vendorId }),
      );
      assert.equal(accepted.status, 200);
      assert.equal(
        (await payrollState(fixture.orgId)).settings?.craRemittancePartyId,
        fixture.vendorId,
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "remittance frequencies refuse by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const bands = remittanceScheduleForFrequencyKey(
        "rqRemittanceFrequency",
      )!.frequencies.map((band) => band.frequency);

      const mistyped = await refusalOf(
        await PUT(request("PUT", { rqRemittanceFrequency: 3 })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid rqRemittanceFrequency")
          && mistyped.error.includes("must be a frequency name")
          && mistyped.error.includes('"3"')
          && bands.every((band) => mistyped.error.includes(`"${band}"`)),
        `non-string frequency refuses by cause with valid bands: ${mistyped.error}`,
      );

      const crossSchedule = await refusalOf(
        await PUT(request("PUT", { rqRemittanceFrequency: "accelerated_2" })),
      );
      assert.equal(crossSchedule.status, 422);
      assert.ok(
        crossSchedule.error.includes("invalid rqRemittanceFrequency")
          && crossSchedule.error.includes(
            '"accelerated_2" is not a frequency of this schedule',
          )
          && crossSchedule.error.includes("valid frequencies are")
          && bands.every((band) => crossSchedule.error.includes(`"${band}"`)),
        `wrong-schedule frequency refuses by cause: ${crossSchedule.error}`,
      );

      const accepted = await PUT(
        request("PUT", { rqRemittanceFrequency: "twice_monthly" }),
      );
      assert.equal(accepted.status, 200);
      assert.equal(
        (await payrollState(fixture.orgId)).settings?.rqRemittanceFrequency,
        "twice_monthly",
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "boolean payroll settings refuse non-booleans by name",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);

      const cheque = await refusalOf(
        await PUT(request("PUT", { eftFallbackToCheque: "yes" })),
      );
      assert.equal(cheque.status, 422);
      assert.ok(
        cheque.error.includes("invalid eftFallbackToCheque")
          && cheque.error.includes("must be true or false")
          && cheque.error.includes('"yes"'),
        `non-boolean cheque fallback refuses by cause: ${cheque.error}`,
      );

      const holiday = await refusalOf(
        await PUT(request("PUT", { statutoryHolidayPay: 1 })),
      );
      assert.equal(holiday.status, 422);
      assert.ok(
        holiday.error.includes("invalid statutoryHolidayPay")
          && holiday.error.includes("must be true or false")
          && holiday.error.includes('"1"'),
        `non-boolean holiday pay refuses by cause: ${holiday.error}`,
      );

      const accepted = await PUT(
        request("PUT", {
          eftFallbackToCheque: true,
          statutoryHolidayPay: true,
        }),
      );
      assert.equal(accepted.status, 200);
      const stored = (await payrollState(fixture.orgId)).settings ?? {};
      assert.equal(stored.eftFallbackToCheque, true);
      assert.equal(stored.statutoryHolidayPay, true);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "t4Transmitter refuses by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);

      const nulled = await refusalOf(
        await PUT(request("PUT", { t4Transmitter: null })),
      );
      assert.equal(nulled.status, 422);
      assert.ok(
        nulled.error.includes("invalid t4Transmitter")
          && nulled.error.includes("got null"),
        `null transmitter refuses by cause: ${nulled.error}`,
      );

      const listed = await refusalOf(
        await PUT(request("PUT", { t4Transmitter: [] })),
      );
      assert.equal(listed.status, 422);
      assert.ok(
        listed.error.includes("invalid t4Transmitter")
          && listed.error.includes("got a list"),
        `list transmitter refuses by cause: ${listed.error}`,
      );

      const mistyped = await refusalOf(
        await PUT(request("PUT", { t4Transmitter: "x" })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid t4Transmitter")
          && mistyped.error.includes('got "x"'),
        `string transmitter refuses by cause: ${mistyped.error}`,
      );

      const badField = await refusalOf(
        await PUT(request("PUT", { t4Transmitter: { bn: 123 } })),
      );
      assert.equal(badField.status, 422);
      assert.ok(
        badField.error.includes("invalid t4Transmitter.bn")
          && badField.error.includes("must be text")
          && badField.error.includes('"123"'),
        `non-string transmitter field refuses by cause: ${badField.error}`,
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);

      const accepted = await PUT(
        request("PUT", {
          t4Transmitter: { bn: " 123456789 ", name: "Acme" },
        }),
      );
      assert.equal(accepted.status, 200);
      assert.deepEqual(
        (await payrollState(fixture.orgId)).settings?.t4Transmitter,
        { bn: "123456789", name: "Acme" },
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "stubPassword refuses by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);

      const nulled = await refusalOf(
        await PUT(request("PUT", { stubPassword: null })),
      );
      assert.equal(nulled.status, 422);
      assert.ok(
        nulled.error.includes("invalid stubPassword")
          && nulled.error.includes("got null"),
        `null stub password refuses by cause: ${nulled.error}`,
      );

      const listed = await refusalOf(
        await PUT(request("PUT", { stubPassword: [] })),
      );
      assert.equal(listed.status, 422);
      assert.ok(
        listed.error.includes("invalid stubPassword")
          && listed.error.includes("got a list"),
        `list stub password refuses by cause: ${listed.error}`,
      );

      const mistyped = await refusalOf(
        await PUT(request("PUT", { stubPassword: "x" })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid stubPassword")
          && mistyped.error.includes('got "x"'),
        `string stub password refuses by cause: ${mistyped.error}`,
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);

      const accepted = await PUT(
        request("PUT", { stubPassword: { enabled: false, expression: "" } }),
      );
      assert.equal(accepted.status, 200);
      assert.deepEqual(
        (await payrollState(fixture.orgId)).settings?.stubPassword,
        { enabled: false, expression: "" },
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "countries refuses by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);
      const installed = Object.keys(PAYROLL_COUNTRY_PACKS).join(", ");

      const mistyped = await refusalOf(
        await PUT(request("PUT", { countries: "CA" })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid countries")
          && mistyped.error.includes("must be a list")
          && mistyped.error.includes('got "CA"'),
        `non-list countries refuses by cause: ${mistyped.error}`,
      );

      const unknown = await refusalOf(
        await PUT(request("PUT", { countries: ["XX"] })),
      );
      assert.equal(unknown.status, 422);
      assert.ok(
        unknown.error.includes("invalid countries")
          && unknown.error.includes('"XX" is not an installed payroll country')
          && unknown.error.includes(`installed countries are: ${installed}`),
        `unknown country refuses by cause: ${unknown.error}`,
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);

      const accepted = await PUT(request("PUT", { countries: ["CA"] }));
      assert.equal(accepted.status, 200);
      assert.deepEqual(
        (await payrollState(fixture.orgId)).settings?.countries,
        ["CA"],
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "slotAccounts refuses by named cause",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const before = await payrollState(fixture.orgId);
      const installed = Object.keys(PAYROLL_COUNTRY_PACKS).join(", ");
      const caPack = PAYROLL_COUNTRY_PACKS.CA;
      assert.ok(caPack, "expected the CA pack to be registered");
      const declared = caPack.statutorySlots.map(
        (slot) => `"${slot.key}"`,
      );

      const nulled = await refusalOf(
        await PUT(request("PUT", { slotAccounts: null })),
      );
      assert.equal(nulled.status, 422);
      assert.ok(
        nulled.error.includes("invalid slotAccounts")
          && nulled.error.includes("got null"),
        `null slot accounts refuses by cause: ${nulled.error}`,
      );

      const listed = await refusalOf(
        await PUT(request("PUT", { slotAccounts: [] })),
      );
      assert.equal(listed.status, 422);
      assert.ok(
        listed.error.includes("invalid slotAccounts")
          && listed.error.includes("got a list"),
        `list slot accounts refuses by cause: ${listed.error}`,
      );

      const mistyped = await refusalOf(
        await PUT(request("PUT", { slotAccounts: "x" })),
      );
      assert.equal(mistyped.status, 422);
      assert.ok(
        mistyped.error.includes("invalid slotAccounts")
          && mistyped.error.includes('got "x"'),
        `string slot accounts refuses by cause: ${mistyped.error}`,
      );

      const unknownCountry = await refusalOf(
        await PUT(request("PUT", { slotAccounts: { XX: {} } })),
      );
      assert.equal(unknownCountry.status, 422);
      assert.ok(
        unknownCountry.error.includes("invalid pack XX")
          && unknownCountry.error.includes(
            'no payroll pack is installed for "XX"',
          )
          && unknownCountry.error.includes(
            `installed countries are: ${installed}`,
          ),
        `unknown pack refuses by cause: ${unknownCountry.error}`,
      );

      const nullSlots = await refusalOf(
        await PUT(request("PUT", { slotAccounts: { CA: null } })),
      );
      assert.equal(nullSlots.status, 422);
      assert.ok(
        nullSlots.error.includes("invalid pack CA")
          && nullSlots.error.includes("got null"),
        `null country slots refuses by cause: ${nullSlots.error}`,
      );

      const mistypedSlots = await refusalOf(
        await PUT(request("PUT", { slotAccounts: { CA: "x" } })),
      );
      assert.equal(mistypedSlots.status, 422);
      assert.ok(
        mistypedSlots.error.includes("invalid pack CA")
          && mistypedSlots.error.includes('got "x"'),
        `string country slots refuses by cause: ${mistypedSlots.error}`,
      );

      const unknownSlot = await refusalOf(
        await PUT(request("PUT", { slotAccounts: { CA: { nope: null } } })),
      );
      assert.equal(unknownSlot.status, 422);
      assert.ok(
        unknownSlot.error.includes("invalid slot CA/nope")
          && unknownSlot.error.includes('no statutory slot "nope"')
          && declared.every((key) => unknownSlot.error.includes(key)),
        `unknown slot refuses by cause with declared slots: ${unknownSlot.error}`,
      );

      const mistypedAccount = await refusalOf(
        await PUT(
          request("PUT", { slotAccounts: { CA: { income_tax: 5 } } }),
        ),
      );
      assert.equal(mistypedAccount.status, 422);
      assert.ok(
        mistypedAccount.error.includes(
          "invalid account for CA/income_tax",
        )
          && mistypedAccount.error.includes("must be an account id or null")
          && mistypedAccount.error.includes('"5"'),
        `non-string slot account refuses by cause: ${mistypedAccount.error}`,
      );

      const malformedAccount = await refusalOf(
        await PUT(
          request("PUT", { slotAccounts: { CA: { income_tax: "nope" } } }),
        ),
      );
      assert.equal(malformedAccount.status, 422);
      assert.ok(
        malformedAccount.error.includes(
          "invalid account for CA/income_tax",
        ) && malformedAccount.error.includes('"nope" is not an account id'),
        `non-uuid slot account refuses by cause: ${malformedAccount.error}`,
      );
      assert.deepEqual(await payrollState(fixture.orgId), before);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "slotAccounts maps a declared slot onto a real account",
  { skip: !DB },
  async () => {
    const fixture = await scratchPayrollOrg();
    try {
      authorize(fixture.orgId, fixture.actorId);
      const installed = await POST(
        request("POST", { action: "install-pack", country: "CA" }),
      );
      assert.equal(installed.status, 200);

      const accepted = await PUT(
        request("PUT", {
          slotAccounts: { CA: { income_tax: fixture.accounts.ap } },
        }),
      );
      assert.equal(accepted.status, 200);
      assert.equal(
        (await payrollState(fixture.orgId)).taxAccount,
        fixture.accounts.ap,
      );
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "settings GET serves installable packs as country/name pairs from the registry",
  { skip: !DB },
  async () => {
    // The onboarding wizard rendered every pack past CA/US as a bare code
    // because this endpoint handed out codes only. The pairs come from the
    // same registry declaration as the packs tab, so the two surfaces cannot
    // disagree about what is installable or what it is called.
    const { installablePayrollPacks, PAYROLL_COUNTRY_PACKS } = await import(
      "../../../../../engine/src/payroll/packs.ts"
    );
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
    try {
      authorize(fixture.orgId, fixture.actorId);
      // The route handlers that mutate wrap themselves in the org
      // transaction; reads rely on the ambient request-org context, which
      // only exists inside withOrgContext outside a Next request store.
      const installed = await withOrgContext(fixture.orgId, () =>
        POST(request("POST", { action: "install-pack", country: "GB" })),
      );
      assert.equal(installed.status, 200, await installed.clone().text());
      const res = await withOrgContext(fixture.orgId, () => GET());
      assert.equal(res.status, 200, await res.clone().text());
      const body = (await res.json()) as {
        installable: string[];
        installablePacks: { country: string; name: string }[];
        packs: { country: string; name: string; slots: unknown[] }[];
      };
      assert.deepEqual(body.installablePacks, installablePayrollPacks());
      const gb = body.packs.find((pack) => pack.country === "GB");
      assert.equal(gb?.name, PAYROLL_COUNTRY_PACKS["GB"]!.name);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
)

test(
  'settings GET includes active org-wide vendors for a subsidiary-scoped operator',
  { skip: !DB },
  async () => {
    const org = await withBypass(async () => {
      const fixture = await createScratchOrg()
      return {
        ...fixture,
        actorId: await createScratchUser(fixture.orgId, 'Scoped Payroll Admin', 'payroll_admin'),
      }
    })
    try {
      authorize(org.orgId, org.actorId, new Set([org.subsidiaryId]))
      await withOrgContext(org.orgId, () => db.execute(sql`
        insert into vendor_roles (org_id, party_id, is_active)
        values (${org.orgId}, ${org.vendorId}, true)
      `))

      const response = await withOrgContext(org.orgId, () => GET())
      assert.equal(response.status, 200, await response.clone().text())
      const body = await response.json() as { vendors: Array<{ id: string; label: string }> }
      assert.ok(
        body.vendors.some((vendor) => vendor.id === org.vendorId && vendor.label === 'Acme Vendor'),
        'a vendor with no subsidiary assignment is visible to every subsidiary-scoped payroll operator',
      )
    } finally {
      routeState.authz = null
      await dropScratchOrg(org.orgId)
    }
  },
)
