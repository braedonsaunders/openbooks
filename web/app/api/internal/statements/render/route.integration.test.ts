import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

process.env.OPENBOOKS_INTERNAL_TOKEN = "batch-render-token";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}",
      };
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { createStatementBatchRun } = await import("@openbooks/engine/receivables/statement-batches");
const { registerRequestOrgResolver } = await import("@openbooks/engine/platform/db");
const render = await import("./route");
registerRequestOrgResolver(() => ({ orgId: null, bypass: true }));

function url(orgId: string, runId: string, partyId: string, token = "batch-render-token") {
  return new Request(`http://audit.local/api?orgId=${orgId}&runId=${runId}&partyId=${partyId}`, {
    headers: { "x-internal-token": token },
  });
}

/**
 * The batch worker renders through this endpoint: it answers the run's
 * customer with the same statement PDF the single send emails, refuses a
 * bad token, and refuses when the creator lost the send grants.
 */
test("internal statement render serves the run customer and respects revoked grants", async () => {
  const org = await createScratchOrg();
  try {
    const senderId = await createScratchUser(org.orgId, "Batch Sender", "reviewer");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
    const created = await withOrgContext(org.orgId, () =>
      createStatementBatchRun({
        orgId: org.orgId,
        senderId,
        periodFrom: null,
        periodTo: org.date,
        filters: {},
        recipients: [
          {
            partyId: org.customerId,
            balance: "0.0000",
            overdue: "0.0000",
            currency: "CAD",
            toEmail: "office@acme.test",
          },
        ],
        excluded: [],
        allowedSubsidiaryIds: null,
        enqueue: async () => {},
      }),
    );

    const denied = await render.GET(url(org.orgId, created.runId, org.customerId, "wrong-token"));
    assert.equal(denied.status, 401);

    const served = await render.GET(url(org.orgId, created.runId, org.customerId));
    assert.equal(served.status, 200, served.status === 200 ? "" : await served.clone().text());
    assert.match(served.headers.get("content-type") ?? "", /application\/pdf/);
    assert.ok((served.headers.get("x-statement-filename") ?? "").length > 0);
    const pdf = Buffer.from(await served.arrayBuffer());
    assert.ok(pdf.subarray(0, 5).toString() === "%PDF-");

    const stranger = await render.GET(
      url(org.orgId, created.runId, "018f6b2a-0000-7000-8000-000000000002"),
    );
    assert.equal(stranger.status, 404);

    await db.execute(
      sql`update app_roles set permissions='["ar.read"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
    const revoked = await render.GET(url(org.orgId, created.runId, org.customerId));
    assert.equal(revoked.status, 403);
    assert.match(((await revoked.json()) as { error: string }).error, /no longer holds/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
