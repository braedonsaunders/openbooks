import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

const auth = { orgId: "", actorId: "", allowed: null as Set<string> | null };
Object.assign(globalThis, { __settlementReviewAuth: auth });
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "@/lib/authz" ||
      specifier.endsWith("/lib/authz") ||
      (specifier === "./authz" && context.parentURL?.includes("/web/lib/"))
    )
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
        export async function getAuthz() {
          const s = globalThis.__settlementReviewAuth;
          return {user:{orgId:s.orgId,id:s.actorId},permissions:new Set(['banking.read','banking.reconcile']),allowedSubsidiaryIds:s.allowed};
        }
        export function can(a,p){return a.permissions.has(p)}
        export async function guardPermission(p){const a=await getAuthz();if(!can(a,p))throw Error('Fixture authority missing');return a;}
        export function guardSubsidiaryScope(){return null}
        export function guardUnrestrictedScope(){return null}
      `),
      };
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { importSettlementBatch, parseStripeBalanceTransactions, postSettlementBatch } =
  await import("@openbooks/engine/payments/psp-settlement");
const { GET } = await import("./route.ts");
const enabled = Boolean(process.env.OPENBOOKS_DB_URL);

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => seedFlowActors(org.orgId));
  const roles = await withBypassContext(() =>
    db.execute(
      sql`update app_roles set permissions='["banking.read","banking.reconcile"]'::jsonb
    where org_id=${org.orgId} and key='admin' returning id`,
      "objects",
    ),
  );
  assert.equal(roles.length, 1);
  const settings = await withBypassContext(() =>
    db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb) || '{"banking":true}'::jsonb,true) where id=${org.orgId} returning id`,
      "objects",
    ),
  );
  assert.equal(settings.length, 1);
  auth.orgId = org.orgId;
  auth.actorId = actor.adminId;
  auth.allowed = null;
  return { ...org, actorId: actor.adminId };
}
async function detail(orgId: string, batchId: string) {
  return withOrgContext(orgId, () =>
    GET(new Request(`http://review.local/api/psp/settlements?batchId=${batchId}`)),
  );
}
async function importDraft(fx: Awaited<ReturnType<typeof fixture>>, subsidiaryId: string | null) {
  const parsed = parseStripeBalanceTransactions(
    [{ id: "charge-1", type: "charge", amount: 45996, fee: 1844, net: 44152, currency: "cad" }],
    randomUUID(),
    fx.date,
  );
  return withOrgContext(fx.orgId, () =>
    importSettlementBatch(fx.orgId, fx.actorId, parsed, {
      bankAccountId: fx.accounts.bank,
      feeAccountId: fx.accounts.freight,
      clearingAccountId: fx.accounts.clearing,
      subsidiaryId: subsidiaryId ?? undefined,
    }),
  );
}

test(
  "native settlement review exposes saved mapping and draft root basis without posting, then preserves recorded journal scope",
  { skip: !enabled },
  async () => {
    const fx = await fixture();
    try {
      const draft = await importDraft(fx, null);
      const before = (
        await withBypassContext(() =>
          db.execute(
            sql`select count(*)::int as n from journal_entries where org_id=${fx.orgId}`,
            "objects",
          ),
        )
      )[0];
      const response = await detail(fx.orgId, draft.batchId);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.batch.bankAccountId, fx.accounts.bank);
      assert.equal(body.batch.feeAccountId, fx.accounts.freight);
      assert.equal(body.batch.clearingAccountId, fx.accounts.clearing);
      assert.ok(body.batch.bankAccountLabel.length > 0);
      assert.equal(body.batch.postingEntityId, fx.subsidiaryId);
      assert.equal(body.batch.postingBookId, fx.bookId);
      assert.equal(body.batch.postingBasis, "current");
      assert.equal(body.batch.status, "draft");
      assert.equal(body.batch.journalEntryId, null);
      assert.equal(body.batch.netAmount, "441.5200");
      assert.deepEqual(
        (
          await withBypassContext(() =>
            db.execute(
              sql`select count(*)::int as n from journal_entries where org_id=${fx.orgId}`,
              "objects",
            ),
          )
        )[0],
        before,
      );
      const posted = await withOrgContext(fx.orgId, () =>
        postSettlementBatch(fx.orgId, draft.batchId, fx.actorId, null),
      );
      const postedResponse = await detail(fx.orgId, draft.batchId);
      assert.equal(postedResponse.status, 200);
      const retained = await postedResponse.json();
      assert.equal(retained.batch.postingBasis, "recorded");
      assert.equal(retained.batch.journalEntryId, posted.entryId);
      assert.equal(retained.batch.postingBookId, fx.bookId);
      assert.equal(retained.batch.postingEntityId, fx.subsidiaryId);
      assert.equal(retained.batch.bankAccountId, body.batch.bankAccountId);
    } finally {
      auth.allowed = null;
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "native settlement review does not guess an ambiguous entity or reveal another entity or tenant mapping",
  { skip: !enabled },
  async () => {
    const fx = await fixture();
    try {
      const other = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id,tax_ids,is_elimination,is_active,custom)
      values(${other},${fx.orgId},'Other entity','CAD','CA',${fx.subsidiaryId},'{}'::jsonb,false,true,'{}'::jsonb)`),
      );
      const ambiguous = await importDraft(fx, null);
      const response = await detail(fx.orgId, ambiguous.batchId);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).batch.postingEntityId, null);
      const restricted = await importDraft(fx, other);
      auth.allowed = new Set([fx.subsidiaryId]);
      assert.equal((await detail(fx.orgId, restricted.batchId)).status, 404);
      auth.allowed = null;
      assert.equal((await detail(fx.orgId, randomUUID())).status, 404);
      const foreign = await fixture();
      try {
        assert.equal((await detail(foreign.orgId, restricted.batchId)).status, 404);
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(foreign.orgId));
      }
    } finally {
      auth.orgId = fx.orgId;
      auth.allowed = null;
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);
