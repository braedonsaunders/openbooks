import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { getApplicationTaxReturn } = await import("./tax-read");
const { ApplicationError } = await import("./errors");
type ApplicationContext = import("./context").ApplicationContext;

function appContext(orgId: string, subsidiaryIds: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: { orgId, id: randomUUID() } as ApplicationContext["authz"]["user"],
      permissions: new Set(["reports.read"]),
      allowedSubsidiaryIds: subsidiaryIds,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function seedFormulaReturn(orgId: string, formCode: string): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
    values (${randomUUID()}, ${orgId}, ${formCode}, 'Test filing', 'portal_manual', true)`));
  await withBypassContext(() => db.execute(sql`
    insert into tax_report_lines
      (id, org_id, report_code, line_code, label, sign, sequence, formula)
    values (${randomUUID()}, ${orgId}, ${formCode}, '101', 'Taxable sales', 1, 10, '2.5')`));
}

test("application tax return preserves exact decimal values from the real filing engine", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await seedFormulaReturn(org.orgId, "T1_EXACT_RETURN");
    const result = await withOrgContext(org.orgId, () => getApplicationTaxReturn(
      appContext(org.orgId, new Set([org.subsidiaryId])),
      {
        formCode: "T1_EXACT_RETURN",
        from: org.date,
        to: org.date,
        subsidiaryIds: [org.subsidiaryId],
      },
    ));

    assert.equal(result.currency, "CAD");
    assert.deepEqual(result.subsidiaryIds, [org.subsidiaryId]);
    assert.deepEqual(result.boxes.map(({ lineCode, value }) => ({ lineCode, value })), [
      { lineCode: "101", value: "2.5000" },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("application tax return maps an unknown-form engine refusal to a named 422", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await assert.rejects(
      withOrgContext(org.orgId, () => getApplicationTaxReturn(
        appContext(org.orgId, null),
        { formCode: "T1_UNKNOWN_RETURN", from: org.date, to: org.date },
      )),
      (error: unknown) => error instanceof ApplicationError
        && error.code === "invalid_input"
        && error.status === 422
        && error.message === 'tax return form "T1_UNKNOWN_RETURN" is not configured',
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
