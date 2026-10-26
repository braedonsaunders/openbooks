import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedPostingAccount,
} from "@openbooks/engine/testing/fixtures";
import { saveProcessorReceiptPolicy } from "@openbooks/engine/payments/documents";
import { ensurePartyRoleRow } from "../../../lib/party-roles";

const session = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __processorReceiptRouteAuth: session });
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/payments/")) ||
      specifier === "@/lib/authz"
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function getAuthz(){return {user:globalThis.__processorReceiptRouteAuth.user,allowedSubsidiaryIds:null,permissions:new Set(['ar.pay'])}};export function can(a,p){return a.permissions.has(p)};export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    return next(specifier, context);
  },
});
const { POST } = await import("./route.ts");

test(
  "the native receipt endpoint saves and replays its exact processor pool scope without posting",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(
        org.orgId,
        "Receipt accountant",
        "receipt_accountant",
      );
      await grantScratchPermissions(org.orgId, actorId, ["ar.pay", "admin.setup.manage"]);
      session.user = { orgId: org.orgId, id: actorId };
      await ensurePartyRoleRow(db, {
        orgId: org.orgId,
        partyId: org.customerId,
        kind: "customer",
        actorId,
      });
      const pool = await seedPostingAccount(
        org.orgId,
        "1040",
        "Processor clearing",
        "asset_current_other",
      );
      const policy = {
        id: randomUUID(),
        accountId: pool,
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        effectiveFrom: org.date,
        effectiveTo: null,
      };
      await saveProcessorReceiptPolicy(
        org.orgId,
        "stripe",
        policy,
        actorId,
        "Collect processor-funded invoice receipts",
        null,
      );
      const body = {
        kind: "customer_payment",
        partyId: org.customerId,
        bankAccountId: pool,
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        documentDate: org.date,
        onAccountAmount: "459.96",
      };
      const key = randomUUID();
      const save = (payload = body) =>
        POST(
          new Request("http://openbooks.test/api/payments", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": key },
            body: JSON.stringify(payload),
          }) as never,
        ) as unknown as Promise<Response>;
      const created = await save();
      assert.equal(created.status, 201, await created.clone().text());
      const result = (await created.json()) as {
        doc: {
          id: string;
          status: string;
          currency: string;
          total: string;
          custom: { processorFunding: { id: string } };
        };
        bankAccountId: string;
      };
      assert.equal(result.doc.status, "draft");
      assert.equal(result.doc.currency, "CAD");
      assert.equal(result.doc.total, "459.9600");
      assert.equal(result.bankAccountId, pool);
      assert.equal(result.doc.custom.processorFunding.id, policy.id);
      const retry = await save();
      assert.equal(retry.status, 200, await retry.clone().text());
      assert.equal(((await retry.json()) as typeof result).doc.id, result.doc.id);
      assert.equal((await save({ ...body, currency: "USD" })).status, 409);
      assert.equal((await save({ ...body, subsidiaryId: randomUUID() })).status, 404);
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from journal_entries
      where org_id = ${org.orgId} and source_document_id = ${result.doc.id}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
