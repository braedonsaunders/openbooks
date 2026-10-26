import { withSimClock } from "@openbooks/engine/testing/platform/clock";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "@openbooks/engine/platform/db";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { receiveInventory } from "@openbooks/engine/inventory/movements";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  grantScratchPermissions,
  type ScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { PortalRefusal } from "@openbooks/engine/testing/portal/errors";
import {
  consumePortalLink,
  requestPortalLink,
  revokePortalSession,
} from "@openbooks/engine/testing/portal/tokens";
import { readPortalSettings, savePortalSettings } from "@openbooks/engine/testing/portal/settings";
import { portalReturnableSources, requestPortalReturn } from "./returns.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const EMAIL = "portal-returns@example.com";

const postingDeps = (org: ScratchOrg) => ({
  control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
});

async function enablePortal(orgId: string): Promise<void> {
  const result = await withBypassContext(() =>
    db.execute(
      sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"customerPortal": true, "warehousing": true, "fulfillment": true, "returnAuthorizations": true}'::jsonb)
     where id = ${orgId} returning id`,
      "objects",
    ),
  );
  assert.equal(result.length, 1);
}

async function postedSale(
  org: ScratchOrg,
  quantity: string,
): Promise<{ documentId: string; issueId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-${documentId.slice(0, 8)}`}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1, 'draft', '100', '0', '100', '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                stock_location_id, custom, tax_overridden)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, ${quantity},
            '10', '100', '0', false, '0', '0', ${org.stockLocationId}, '{}'::jsonb, false)`);
  const approved = await db.execute(
    sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId} returning id`,
    "objects",
  );
  assert.equal(approved.length, 1);
  await postDocument(documentId, postingDeps(org));
  const issue = (
    await db.execute<{ id: string }>(
      sql`
    select id from inventory_movements where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`,
      "objects",
    )
  )[0];
  assert.ok(issue);
  return { documentId, issueId: issue.id };
}

async function portalSession(org: ScratchOrg): Promise<string> {
  await withBypassContext(() =>
    db.execute(sql`
    update parties set email = ${EMAIL} where id = ${org.customerId} and org_id = ${org.orgId}`),
  );
  const requested = await requestPortalLink(EMAIL);
  assert.equal(requested.links.length, 1);
  const consumed = await consumePortalLink(requested.links[0]!.token);
  return consumed.sessionToken;
}

test(
  "a portal return request creates an RMA through the standard pipeline",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await enablePortal(org.orgId);
      const actorId = org.customerId;
      await withBypassContext(() =>
        savePortalSettings(org.orgId, actorId, { returnWindowDays: 90 }),
      );
      await withOrg(org.orgId, () =>
        receiveInventory(org.orgId, actorId, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          quantity: "10",
          unitCost: "4",
          subsidiaryId: org.subsidiaryId,
          offsetAccountId: org.accounts.clearing,
          date: org.date,
        }),
      );
      const sale = await withOrg(org.orgId, () => postedSale(org, "10"));
      const token = await portalSession(org);
      const sources = await portalReturnableSources(token, sale.documentId);
      assert.equal(sources.length, 1);
      assert.equal(sources[0]!.movementId, sale.issueId);
      const authorization = await withSimClock("2026-07-20T12:00:00Z", () =>
        requestPortalReturn({
          sessionToken: token,
          sourceDocumentId: sale.documentId,
          reasonCode: "damaged",
          resolution: "store_credit",
          lines: [{ sourceIssueMovementId: sale.issueId, quantity: "4" }],
        }),
      );
      assert.equal(authorization.stage, "requested");
      assert.match(authorization.documentNumber, /^RMA/);
      const stored = (
        await withBypassContext(() =>
          db.execute<{ memo: string | null }>(
            sql`
      select memo from documents where id = ${authorization.id} and org_id = ${org.orgId}`,
            "objects",
          ),
        )
      )[0]!;
      assert.match(stored.memo ?? "", /damaged/);
      assert.match(stored.memo ?? "", /store_credit/);
      const events = await withBypassContext(() =>
        db.execute<{ action: string; reason_code: string | null; detail: unknown }>(
          sql`
      select action, reason_code, detail from customer_portal_events
       where org_id = ${org.orgId} and party_id = ${org.customerId} and action = 'return_requested'`,
          "objects",
        ),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.reason_code, "damaged");
      const detail = events[0]!.detail as Record<string, unknown>;
      assert.equal(detail["resolution"], "store_credit");
      assert.equal(detail["rmaId"], authorization.id);
      const ungated = await withBypassContext(() =>
        db.execute<{ status: string }>(
          sql`
      select status from documents where org_id=${org.orgId} and id=${authorization.id}`,
          "objects",
        ),
      );
      assert.equal(ungated[0]!.status, "approved");
      await withBypassContext(async () => {
        const actors = await seedFlowActors(org.orgId);
        await grantScratchPermissions(org.orgId, actors.approver1Id, ["orders.fulfill"]);
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,flows}','true'::jsonb) where id=${org.orgId}`,
        );
        await seedApprovalFlow(org.orgId, {
          subjectKind: "rma",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "any",
        });
      });
      const gated = await withSimClock("2026-07-20T12:00:00Z", () =>
        requestPortalReturn({
          sessionToken: token,
          sourceDocumentId: sale.documentId,
          reasonCode: "damaged",
          resolution: "refund",
          lines: [{ sourceIssueMovementId: sale.issueId, quantity: "1" }],
        }),
      );
      const pending = await withBypassContext(() =>
        db.execute<{ status: string }>(
          sql`
      select status from documents where org_id=${org.orgId} and id=${gated.id}`,
          "objects",
        ),
      );
      assert.equal(pending[0]!.status, "pending_approval");
      const request = (
        await withBypassContext(() =>
          db.execute<{ request: Record<string, unknown> }>(
            sql`
      select custom->'portalRequest' as request from documents where org_id=${org.orgId} and id=${gated.id}`,
            "objects",
          ),
        )
      )[0]!.request;
      const sourceValid = (subjectOrg: string, sourceRequest: Record<string, unknown>) =>
        withOrg(
          org.orgId,
          async () =>
            (
              await db.execute<{ valid: boolean }>(
                sql`select public.flow_portal_return_source_valid(
        ${subjectOrg}::uuid,${gated.id}::uuid,${JSON.stringify(sourceRequest)}::jsonb) as valid`,
                "objects",
              )
            )[0]!.valid,
        );
      assert.equal(await sourceValid(org.orgId, request), true);
      assert.equal(await sourceValid(randomUUID(), request), false);
      assert.equal(await sourceValid(org.orgId, { ...request, partyId: randomUUID() }), false);
      assert.equal(await sourceValid(org.orgId, { ...request, linkId: randomUUID() }), false);
      const receipt = (
        await withBypassContext(() =>
          db.execute<{ actor_id: string | null; source: string }>(
            sql`
      select actor_id,context->>'event_source' as source from flow_submissions
      where org_id=${org.orgId} and subject_id=${gated.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(receipt.actor_id, null);
      assert.equal(receipt.source, "portal");
      await revokePortalSession(token);
      assert.equal(await sourceValid(org.orgId, request), false);
      await assert.rejects(
        requestPortalReturn({
          sessionToken: token,
          sourceDocumentId: sale.documentId,
          reasonCode: "damaged",
          resolution: "refund",
          lines: [{ sourceIssueMovementId: sale.issueId, quantity: "1" }],
        }),
        (error: unknown) => error instanceof PortalRefusal && error.code === "invalid_link",
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test("a portal return outside the configured window refuses by name", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enablePortal(org.orgId);
    const actorId = org.customerId;
    await withOrg(org.orgId, () =>
      receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "4",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    const sale = await withOrg(org.orgId, () => postedSale(org, "10"));
    const token = await portalSession(org);
    await withBypassContext(() => savePortalSettings(org.orgId, actorId, { returnWindowDays: 0 }));
    await assert.rejects(
      requestPortalReturn({
        sessionToken: token,
        sourceDocumentId: sale.documentId,
        reasonCode: "damaged",
        resolution: "refund",
        lines: [{ sourceIssueMovementId: sale.issueId, quantity: "1" }],
      }),
      (error: unknown) =>
        error instanceof PortalRefusal &&
        error.code === "outside_return_window" &&
        /0-day return window/.test(error.message) &&
        /last day/.test(error.message),
    );
    const rmas = (
      await withBypassContext(() =>
        db.execute<{ count: string }>(
          sql`
      select count(*)::text as count from documents
       where org_id = ${org.orgId} and kind = 'rma'`,
          "objects",
        ),
      )
    )[0]!.count;
    assert.equal(rmas, "0");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test(
  "portal return reasons are required only while portal returns are on",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = org.customerId;
      await withBypassContext(() =>
        savePortalSettings(org.orgId, actorId, { sections: { returns: false }, returnReasons: [] }),
      );
      const off = await withBypassContext(() => readPortalSettings(org.orgId));
      assert.equal(off.sections.returns, false);
      assert.deepEqual(off.returnReasons, []);

      await assert.rejects(
        withBypassContext(() =>
          savePortalSettings(org.orgId, actorId, {
            sections: { returns: true },
            returnReasons: [],
          }),
        ),
        (error: unknown) =>
          error instanceof PortalRefusal &&
          error.code === "invalid_input" &&
          error.status === 422 &&
          /return reason/.test(error.message),
      );

      await withBypassContext(() =>
        savePortalSettings(org.orgId, actorId, {
          sections: { returns: true },
          returnReasons: ["damaged"],
        }),
      );
      await withBypassContext(() =>
        savePortalSettings(org.orgId, actorId, {
          sections: { returns: false },
          returnReasons: null,
        }),
      );
      const kept = await withBypassContext(() => readPortalSettings(org.orgId));
      assert.equal(kept.sections.returns, false);
      assert.deepEqual(kept.returnReasons, ["damaged"]);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
