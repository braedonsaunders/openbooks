import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, withBypassContext, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
} from "@openbooks/engine/testing/fixtures";
import {
  createPaymentDocument,
  updateDraftPayment,
} from "@openbooks/engine/payments/payment-documents";
import { postPaymentWithApplications } from "@openbooks/engine/payments/payment-posting";
import { submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import {
  claimPostingEffectsForDocument,
  markPostingEffectsFailed,
  MAX_POSTING_EFFECTS_ATTEMPTS,
} from "@openbooks/engine/ledger/posting-effects";

const session = {
  user: { orgId: "", id: "" },
  permissions: new Set<string>(),
  allowed: null as Set<string> | null,
};
// The route factory treats only a NextResponse from an authorizer as a
// refusal, so the scope double answers with the real response class.
Object.assign(globalThis, {
  __paymentEffectRouteSession: session,
  __paymentEffectRouteNextResponse: NextResponse,
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/authz" || specifier.endsWith("/lib/authz"))
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
      export async function getAuthz(){const s=globalThis.__paymentEffectRouteSession;return {user:s.user,permissions:s.permissions,allowedSubsidiaryIds:s.allowed}};
      export function can(a,p){return a.permissions.has(p)};
      export function guardSubsidiaryScope(a,id){if(a.allowedSubsidiaryIds===null||a.allowedSubsidiaryIds.has(id))return null;return globalThis.__paymentEffectRouteNextResponse.json({error:'not_found'},{status:404})}
    `),
      };
    return next(specifier, context);
  },
});
const { POST } = await import("./route.ts");

test(
  "native payment effect retry enforces current receipt duty, entity and feature and queues only the retained outbox",
  {
    skip: !process.env.OPENBOOKS_DB_URL,
  },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Receipt recovery operator", "receipt_recovery"),
      );
      await withBypassContext(async () => {
        await grantScratchPermissions(org.orgId, actorId, ["ar.pay"]);
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,banking}','true'::jsonb) where id=${org.orgId}`,
        );
      });
      session.user = { orgId: org.orgId, id: actorId };
      session.permissions = new Set(["ar.pay"]);
      session.allowed = null;
      const payment = await withOrgTransaction(org.orgId, async () => {
        const receipt = await createPaymentDocument({
          orgId: org.orgId,
          kind: "customer_payment",
          createdBy: actorId,
          allowedSubsidiaryIds: null,
          subsidiaryId: org.subsidiaryId,
          currency: "CAD",
          documentDate: org.date,
          partyId: org.customerId,
          bankAccountId: org.accounts.bank,
        });
        await updateDraftPayment(receipt.id, { onAccountAmount: "100" }, actorId, org.orgId, {
          allowedSubsidiaryIds: null,
        });
        await submitAndReleaseIfUngated("customer_payment", receipt.id, actorId);
        await postPaymentWithApplications(receipt.id, undefined, actorId, "api", {
          deferEffects: true,
        });
        for (let attempt = 0; attempt < MAX_POSTING_EFFECTS_ATTEMPTS; attempt++) {
          const claim = await claimPostingEffectsForDocument(receipt.id);
          assert.ok(claim && typeof claim === "object");
          await markPostingEffectsFailed(
            claim,
            new Error("Receipt projection worker stopped before completing its effects"),
          );
        }
        return receipt;
      });
      const evidence = () =>
        withOrgTransaction(
          org.orgId,
          async () =>
            (
              await db.execute<{
                entry: string;
                entries: number;
                applications: number;
                links: number;
                effect: string;
                status: string;
              }>(
                sql`select d.posted_entry_id as entry, pe.id as effect, pe.status,
      (select count(*)::int from journal_entries where org_id=${org.orgId}) as entries,
      (select count(*)::int from applications where org_id=${org.orgId}) as applications,
      (select count(*)::int from document_links where org_id=${org.orgId}) as links
      from documents d join posting_effects pe on pe.org_id=d.org_id and pe.document_id=d.id
      where d.org_id=${org.orgId} and d.id=${payment.id}`,
                "objects",
              )
            )[0]!,
        );
      const original = await evidence();
      assert.equal(original.status, "terminal_failed");
      const reason = "Receipt projection cause reviewed and resolved before resuming the return";
      const retry = (id = payment.id, payload: unknown = { reason }) =>
        POST(
          new Request(`http://openbooks.test/api/payments/${id}/retry-effects`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
          { params: Promise.resolve({ id }) },
        );
      session.permissions = new Set();
      assert.equal((await retry()).status, 404);
      assert.equal((await retry(randomUUID())).status, 404);
      session.permissions = new Set(["ap.pay"]);
      assert.equal((await retry()).status, 404);
      session.permissions = new Set(["ar.pay"]);
      session.allowed = new Set();
      assert.equal((await retry()).status, 404);
      session.allowed = null;
      await withBypassContext(() =>
        db.execute(sql`update user_permission_overrides set effect='deny'
      where org_id=${org.orgId} and user_id=${actorId} and permission='ar.pay'`),
      );
      assert.equal(
        (await retry()).status,
        404,
        "a stale session grant cannot authorize native recovery",
      );
      await withBypassContext(() => grantScratchPermissions(org.orgId, actorId, ["ar.pay"]));
      await withBypassContext(() =>
        db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id=${org.orgId} and key='receipt_recovery'`),
      );
      assert.equal((await retry()).status, 404);
      await withBypassContext(() =>
        db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb
      where org_id=${org.orgId} and key='receipt_recovery'`),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,banking}','false'::jsonb) where id=${org.orgId}`,
        ),
      );
      assert.equal((await retry()).status, 404);
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,banking}','true'::jsonb) where id=${org.orgId}`,
        ),
      );
      assert.equal((await retry(payment.id, { reason: "short" })).status, 400);
      assert.equal(
        (await retry(payment.id, { reason, action: "post" })).status,
        400,
        "the retry boundary accepts no lifecycle command",
      );
      const otherActor = await withBypassContext(() =>
        createScratchUser(other.orgId, "Other receipt operator", "receipt_recovery"),
      );
      await withBypassContext(() => grantScratchPermissions(other.orgId, otherActor, ["ar.pay"]));
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,banking}','true'::jsonb) where id=${other.orgId}`,
        ),
      );
      session.user = { orgId: other.orgId, id: otherActor };
      assert.equal((await retry()).status, 404);
      session.user = { orgId: org.orgId, id: actorId };
      assert.deepEqual(
        await evidence(),
        original,
        "refusals retain the terminal effect and all accounting",
      );
      const response = await retry();
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()) as {
        payment: {
          doc: {
            id: string;
            status: string;
            posting_effect_status: string;
            posted_entry_id: string;
          };
        };
      };
      assert.equal(result.payment.doc.id, payment.id);
      assert.equal(result.payment.doc.status, "posted");
      assert.equal(result.payment.doc.posted_entry_id, original.entry);
      assert.equal(
        result.payment.doc.posting_effect_status,
        "pending",
        "the same drawer loader observes the queued native effect",
      );
      assert.deepEqual(await evidence(), { ...original, status: "pending" });
      assert.equal((await retry()).status, 422, "a queued effect cannot be reset a second time");
      const audit = await withOrgTransaction(org.orgId, () =>
        db.execute<{ actor_id: string; reason: string }>(
          sql`
      select actor_id, changes->>'reason' as reason from audit_log where org_id=${org.orgId}
        and row_id=${original.effect} and changes->>'event'='posting_effects_replay_authorized'`,
          "objects",
        ),
      );
      assert.deepEqual(audit, [{ actor_id: actorId, reason }]);
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
