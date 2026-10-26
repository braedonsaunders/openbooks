import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withSimClock } from "../platform/clock.ts";
import { sql } from "drizzle-orm";
import { db, withOrg, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import {
  createPlanVersion,
  publishPlanVersion,
  activateLifecycle,
  advanceLifecycleDate,
  prepareAdvancedSubscriptionBilling,
} from "./advanced-subscriptions.ts";
import { activateQuote } from "./quote-to-cash.ts";
import { billSubscriptionNow } from "./subscription-billing.ts";
import { measureLinkedOrderRelief } from "../receivables/credit-policy.ts";
import { generateRenewalDocument, acceptRenewalDocument, runRenewalScan } from "./renewals.ts";

const enabled = Boolean(process.env.OPENBOOKS_DB_URL);
for (const documentKind of ["quote", "sales_order"] as const)
  test(
    `${documentKind} renewal generation is concurrent-idempotent and accepted uplift is effective-dated on the existing subscription`,
    { skip: !enabled },
    async () => {
      const org = await createScratchOrg();
      try {
        const actors = await withBypassContext(() => seedFlowActors(org.orgId)),
          planId = randomUUID(),
          subscriptionId = randomUUID(),
          policyId = randomUUID();
        const termEnd = advanceLifecycleDate(org.date, "monthly", 1);
        await withBypassContext(async () => {
          await grantScratchPermissions(org.orgId, actors.adminId, [
            "ar.read",
            "ar.create",
            "ar.post",
            ...(documentKind === "quote" ? ["estimates.create", "estimates.issue"] : []),
          ]);
          await db.execute(
            sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true,"advancedSubscriptions":true,"multiCurrency":true,"orders":true}'::jsonb) where id=${org.orgId}`,
          );
          await db.execute(
            sql`insert into subscription_plans(id,org_id,name,amount,currency_code,interval,income_account_id,created_by,updated_by) values(${planId},${org.orgId},'Renewable support','100','CAD','monthly',${org.accounts.revenue},${actors.adminId},${actors.adminId})`,
          );
          await db.execute(
            sql`insert into subscriptions(id,org_id,customer_id,plan_id,start_on,next_bill_on,created_by,updated_by) values(${subscriptionId},${org.orgId},${org.customerId},${planId},${org.date},${org.date},${actors.adminId},${actors.adminId})`,
          );
        });
        const version = await withOrg(org.orgId, () =>
          createPlanVersion(
            org.orgId,
            actors.adminId,
            {
              planId,
              effectiveFrom: org.date,
              components: [
                {
                  componentKey: "support",
                  name: "Support",
                  quantity: "1",
                  unitPrice: "100",
                  incomeAccountId: org.accounts.revenue,
                },
              ],
            },
            null,
          ),
        );
        await withOrg(org.orgId, () =>
          publishPlanVersion(org.orgId, actors.adminId, version, null),
        );
        await withOrg(org.orgId, () =>
          activateLifecycle(
            org.orgId,
            actors.adminId,
            {
              subscriptionId,
              planVersionId: version,
              termStartsOn: org.date,
              termEndsOn: termEnd,
              renewalPolicy: "auto",
              renewalTermMonths: 12,
            },
            null,
          ),
        );
        await withBypassContext(() =>
          db.execute(sql`insert into subscription_renewal_policies(id,org_id,subscription_id,subsidiary_id,effective_from,effective_to,owner_id,reminder_days,generation_lead_days,document_kind,uplift_percent,term_months,reason,created_by,updated_by)
    values(${policyId},${org.orgId},${subscriptionId},${org.subsidiaryId},${org.date},${termEnd},${actors.adminId},'[{"days":40}]'::jsonb,3660,${documentKind},'10',12,'Reviewed renewal pricing and notice terms',${actors.adminId},${actors.adminId})`),
        );
        if (documentKind === "quote") {
          const denied = await withBypassContext(() =>
            db.execute<never>(
              sql`update user_permission_overrides set effect='deny' where org_id=${org.orgId} and user_id=${actors.adminId} and permission='estimates.create'`,
            ),
          );
          assert.equal(denied.rowCount, 1);
          await assert.rejects(() =>
            generateRenewalDocument(org.orgId, actors.adminId, subscriptionId, org.date),
          );
          const restored = await withBypassContext(() =>
            db.execute<never>(
              sql`update user_permission_overrides set effect='grant' where org_id=${org.orgId} and user_id=${actors.adminId} and permission='estimates.create'`,
            ),
          );
          assert.equal(restored.rowCount, 1);
        }
        await withSimClock(`${org.date}T12:00:00Z`, () => runRenewalScan());
        await withSimClock(`${org.date}T12:00:00Z`, () => runRenewalScan());
        const noticeCount = (
          await withOrg(org.orgId, () =>
            db.execute<{ count: number }>(
              sql`select count(*)::int as count from subscription_renewal_occurrences where org_id=${org.orgId} and subscription_id=${subscriptionId} and occurrence='reminder:40'`,
              "objects",
            ),
          )
        )[0]!.count;
        assert.equal(noticeCount, 1);
        const docs = await Promise.all([
          generateRenewalDocument(org.orgId, actors.adminId, subscriptionId, org.date),
          generateRenewalDocument(org.orgId, actors.adminId, subscriptionId, org.date),
        ]);
        assert.equal(docs[0]!.documentId, docs[1]!.documentId);
        const quoted = (
          await withOrg(org.orgId, () =>
            db.execute<{ amount: string }>(
              sql`select amount::text from document_lines where org_id=${org.orgId} and document_id=${docs[0]!.documentId}`,
              "objects",
            ),
          )
        )[0]!;
        assert.equal(quoted.amount, "1320.0000");
        assert.equal(
          await withOrg(org.orgId, () =>
            prepareAdvancedSubscriptionBilling(org.orgId, subscriptionId, termEnd),
          ),
          false,
          "commercial acceptance cannot be bypassed by automatic renewal",
        );
        await assert.rejects(
          () =>
            acceptRenewalDocument(
              org.orgId,
              actors.adminId,
              docs[0]!.documentId,
              "Accepted commercial terms",
            ),
          /Approve/,
        );
        await withBypassContext(() =>
          db.execute(
            sql`update documents set status='approved' where org_id=${org.orgId} and id=${docs[0]!.documentId}`,
          ),
        );
        if (documentKind === "quote") {
          await withBypassContext(() =>
            db.execute(
              sql`update orgs set settings=jsonb_set(settings,'{features,quoteToCash}','true'::jsonb,true) where id=${org.orgId}`,
            ),
          );
          await assert.rejects(
            () =>
              activateQuote(org.orgId, actors.adminId, docs[0]!.documentId, {
                allowedSubsidiaryIds: null,
              }),
            /accept the approved renewal in Collections/,
          );
        }
        await acceptRenewalDocument(
          org.orgId,
          actors.adminId,
          docs[0]!.documentId,
          "Accepted approved renewal with customer",
        );
        await acceptRenewalDocument(
          org.orgId,
          actors.adminId,
          docs[0]!.documentId,
          "Accepted approved renewal with customer",
        );
        const prices = await withOrg(org.orgId, () =>
          db.execute<{ effective_from: string; unit_price: string }>(
            sql`select effective_from::text,unit_price::text from subscription_components where org_id=${org.orgId} and subscription_id=${subscriptionId} order by effective_from`,
            "objects",
          ),
        );
        assert.deepEqual(
          prices.map((p) => p.unit_price),
          ["100.0000", "110.0000"],
        );
        assert.equal(prices[1]!.effective_from, termEnd);
        assert.equal(
          (
            await withOrg(org.orgId, () =>
              db.execute<{ count: number }>(
                sql`select count(*)::int as count from subscriptions where org_id=${org.orgId} and id=${subscriptionId}`,
                "objects",
              ),
            )
          )[0]!.count,
          1,
        );
        if (documentKind === "sales_order") {
          assert.equal(
            (
              await withOrg(org.orgId, () =>
                db.execute<{ item_id: string | null }>(
                  sql`select item_id from document_lines where org_id=${org.orgId} and document_id=${docs[0]!.documentId}`,
                  "objects",
                ),
              )
            )[0]!.item_id,
            null,
            "commercial term commitment does not duplicate periodic stock demand",
          );
          await withBypassContext(() =>
            db.execute(
              sql`update subscriptions set next_bill_on=${termEnd},current_period_start=${termEnd},auto_post=false where org_id=${org.orgId} and id=${subscriptionId}`,
            ),
          );
          const invoice = await billSubscriptionNow(
            org.orgId,
            subscriptionId,
            { actorId: actors.adminId },
            null,
          );
          const replay = await billSubscriptionNow(
            org.orgId,
            subscriptionId,
            { actorId: actors.adminId },
            null,
          );
          assert.equal(invoice.invoiceId, replay.invoiceId);
          const edges = await withOrg(org.orgId, () =>
            db.execute<{ link_type: string }>(
              sql`select link_type from document_links where org_id=${org.orgId} and from_document_id=${docs[0]!.documentId} and to_document_id=${invoice.invoiceId}`,
              "objects",
            ),
          );
          assert.deepEqual(
            edges.map((e) => e.link_type),
            ["renews"],
          );
          const relief = await withOrg(org.orgId, () =>
            measureLinkedOrderRelief(
              db,
              org.orgId,
              org.customerId,
              "CAD",
              invoice.invoiceId,
              "110",
            ),
          );
          assert.equal(
            relief,
            "110.0000",
            "native posting credit guard exchanges commitment for a receivable exactly once",
          );
        }
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
