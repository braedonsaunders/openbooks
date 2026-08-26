import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import {
  issueSalesOrder,
  SalesOrderIssueError,
} from "./sales-orders.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantRolePermissions(
  orgId: string,
  roleKey: string,
  permissions: string[],
): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}
  `);
}

async function seedCustomerRole(
  org: ScratchOrg,
  actorId: string,
  input: { creditLimit: string; currency?: string; isOnHold?: boolean },
): Promise<void> {
  await db.execute(sql`
    insert into customer_roles
      (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold,
       hold_reason, held_at, held_by, created_by, updated_by)
    values (
      ${org.orgId}, ${org.customerId}, ${org.accounts.ar}, ${input.creditLimit},
      ${input.currency ?? "CAD"}, ${input.isOnHold ?? false},
      ${input.isOnHold ? "Manual credit review" : null},
      ${input.isOnHold ? sql`now()` : null},
      ${input.isOnHold ? actorId : null}, ${actorId}, ${actorId}
    )
  `);
}

async function seedSalesOrder(
  org: ScratchOrg,
  actorId: string,
  input: {
    number: string;
    total: string;
    status?: "draft" | "pending_approval" | "approved";
    currency?: string;
    quantity?: string;
    quantityBilled?: string;
  },
): Promise<{ id: string; updatedAt: string }> {
  const id = randomUUID();
  const quantity = input.quantity ?? "1";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${id}, ${org.orgId}, 'sales_order', ${input.number}, ${org.customerId},
      ${org.subsidiaryId}, ${org.date}, ${input.currency ?? "CAD"},
      ${input.status ?? "draft"}, ${input.total}, '0', ${input.total},
      ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity,
       quantity_billed, unit_price, amount, tax_input_amount, tax_amount,
       created_by, updated_by)
    values (
      ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, ${quantity},
      ${input.quantityBilled ?? "0"},
      round(${input.total}::numeric / ${quantity}::numeric, 4),
      ${input.total}, ${input.total}, '0', ${actorId}, ${actorId}
    )
  `);
  const updated = (await db.execute<{ updated_at: Date }>(sql`
    select updated_at
      from documents
     where id = ${id} and org_id = ${org.orgId}
  `)).rows[0]!;
  return { id, updatedAt: updated.updated_at.toISOString() };
}

async function seedPostedInvoice(
  org: ScratchOrg,
  actorId: string,
  number: string,
  amount: string,
  currency = "CAD",
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${id}, ${org.orgId}, 'customer_invoice', ${number}, ${org.customerId},
      ${org.subsidiaryId}, ${org.date}, ${currency}, 'approved', ${amount},
      '0', ${amount}, ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price,
       amount, tax_input_amount, tax_amount, created_by, updated_by)
    values (
      ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', ${amount},
      ${amount}, ${amount}, '0', ${actorId}, ${actorId}
    )
  `);
  await postDocument(id, {
    control: {
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
  });
  return id;
}

async function expectIssueError(
  promise: Promise<unknown>,
  code: string,
  status = 422,
): Promise<SalesOrderIssueError> {
  let captured: SalesOrderIssueError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof SalesOrderIssueError)) return false;
    captured = error;
    return error.code === code && error.status === status;
  });
  return captured!;
}

test(
  "credit exposure combines issued-order commitments and unpaid invoices at below/at/over boundaries",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Credit boundary issuer", "credit_boundary_issuer");
      await grantRolePermissions(org.orgId, "credit_boundary_issuer", ["ar.create"]);
      await seedCustomerRole(org, actorId, { creditLimit: "310", currency: "CAD" });
      await seedPostedInvoice(org, actorId, "INV-CREDIT-OPEN-1", "70");
      await seedSalesOrder(org, actorId, {
        number: "SO-CREDIT-COMMITTED-1",
        total: "100",
        status: "approved",
        quantity: "2",
        quantityBilled: "1",
      });

      const below = await seedSalesOrder(org, actorId, {
        number: "SO-CREDIT-BELOW-1",
        total: "40",
      });
      const belowResult = await issueSalesOrder({
        orgId: org.orgId,
        salesOrderId: below.id,
        actorId,
        expectedUpdatedAt: below.updatedAt,
      });
      assert.deepEqual(belowResult.credit, {
        currency: "CAD",
        limit: "310.0000",
        openOrderExposure: "100.0000",
        unpaidInvoiceExposure: "70.0000",
        orderAmount: "40.0000",
        resultingExposure: "210.0000",
        overridden: false,
      });

      const at = await seedSalesOrder(org, actorId, {
        number: "SO-CREDIT-AT-1",
        total: "100",
      });
      const atResult = await issueSalesOrder({
        orgId: org.orgId,
        salesOrderId: at.id,
        actorId,
        expectedUpdatedAt: at.updatedAt,
      });
      assert.equal(atResult.credit?.resultingExposure, "310.0000");

      const over = await seedSalesOrder(org, actorId, {
        number: "SO-CREDIT-OVER-1",
        total: "0.01",
      });
      const refusal = await expectIssueError(
        issueSalesOrder({
          orgId: org.orgId,
          salesOrderId: over.id,
          actorId,
          expectedUpdatedAt: over.updatedAt,
        }),
        "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
      );
      assert.match(refusal.message, /310\.0100 CAD.*310\.0000 CAD/);

      const states = (await db.execute<{ document_number: string; status: string }>(sql`
        select document_number, status
          from documents
         where org_id = ${org.orgId}
           and id in (${below.id}, ${at.id}, ${over.id})
         order by document_number
      `)).rows;
      assert.deepEqual(states, [
        { document_number: "SO-CREDIT-AT-1", status: "approved" },
        { document_number: "SO-CREDIT-BELOW-1", status: "approved" },
        { document_number: "SO-CREDIT-OVER-1", status: "draft" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "customer-role locking lets exactly one of two concurrent orders consume the remaining credit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Concurrent credit issuer", "concurrent_credit_issuer");
      await grantRolePermissions(org.orgId, "concurrent_credit_issuer", ["ar.create"]);
      await seedCustomerRole(org, actorId, { creditLimit: "100" });
      const first = await seedSalesOrder(org, actorId, { number: "SO-CREDIT-RACE-1", total: "60" });
      const second = await seedSalesOrder(org, actorId, { number: "SO-CREDIT-RACE-2", total: "60" });

      const settled = await Promise.allSettled([
        issueSalesOrder({
          orgId: org.orgId,
          salesOrderId: first.id,
          actorId,
          expectedUpdatedAt: first.updatedAt,
        }),
        issueSalesOrder({
          orgId: org.orgId,
          salesOrderId: second.id,
          actorId,
          expectedUpdatedAt: second.updatedAt,
        }),
      ]);
      assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(settled.filter(
        (result) => result.status === "rejected"
          && result.reason instanceof SalesOrderIssueError
          && result.reason.code === "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
      ).length, 1);

      const states = (await db.execute<{ status: string; count: number }>(sql`
        select status, count(*)::int as count
          from documents
         where org_id = ${org.orgId} and id in (${first.id}, ${second.id})
         group by status
         order by status
      `)).rows;
      assert.deepEqual(states, [
        { status: "approved", count: 1 },
        { status: "draft", count: 1 },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "credit enforcement is org scoped and refuses currencies outside the customer-role basis",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Currency credit issuer", "currency_credit_issuer");
      await grantRolePermissions(org.orgId, "currency_credit_issuer", ["ar.create"]);
      await seedCustomerRole(org, actorId, { creditLimit: "100", currency: "CAD" });
      const usd = await seedSalesOrder(org, actorId, {
        number: "SO-CREDIT-USD-1",
        total: "10",
        currency: "USD",
      });
      await expectIssueError(
        issueSalesOrder({
          orgId: org.orgId,
          salesOrderId: usd.id,
          actorId,
          expectedUpdatedAt: usd.updatedAt,
        }),
        "CUSTOMER_CREDIT_CURRENCY_MISMATCH",
      );

      const cad = await seedSalesOrder(org, actorId, {
        number: "SO-CREDIT-ORG-SCOPE-1",
        total: "10",
      });
      await expectIssueError(
        issueSalesOrder({
          orgId: otherOrg.orgId,
          salesOrderId: cad.id,
          actorId,
          expectedUpdatedAt: cad.updatedAt,
        }),
        "SALES_ORDER_NOT_FOUND",
        404,
      );
      const issued = await issueSalesOrder({
        orgId: org.orgId,
        salesOrderId: cad.id,
        actorId,
        expectedUpdatedAt: cad.updatedAt,
      });
      assert.equal(issued.credit?.currency, "CAD");
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(otherOrg.orgId);
    }
  },
);

test(
  "a reasoned credit override requires AR approval authority and leaves immutable audit evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const issuerId = await createScratchUser(org.orgId, "Ordinary credit issuer", "ordinary_credit_issuer");
      const approverId = await createScratchUser(org.orgId, "Credit override approver", "credit_override_approver");
      await grantRolePermissions(org.orgId, "ordinary_credit_issuer", ["ar.create"]);
      await grantRolePermissions(org.orgId, "credit_override_approver", ["ar.create", "ar.approve"]);
      await seedCustomerRole(org, issuerId, { creditLimit: "10" });
      const order = await seedSalesOrder(org, issuerId, {
        number: "SO-CREDIT-OVERRIDE-1",
        total: "20",
      });

      await expectIssueError(
        issueSalesOrder({
          orgId: org.orgId,
          salesOrderId: order.id,
          actorId: issuerId,
          expectedUpdatedAt: order.updatedAt,
          creditOverrideReason: "Customer deposit confirmed by treasury",
        }),
        "CUSTOMER_CREDIT_OVERRIDE_FORBIDDEN",
        403,
      );

      const result = await issueSalesOrder({
        orgId: org.orgId,
        salesOrderId: order.id,
        actorId: approverId,
        expectedUpdatedAt: order.updatedAt,
        creditOverrideReason: "Customer deposit confirmed by treasury",
      });
      assert.equal(result.credit?.overridden, true);

      const evidence = (await db.execute<{
        id: string;
        actor_id: string;
        event: string;
        reason: string;
        resulting_exposure: string;
        credit_limit: string;
      }>(sql`
        select id, actor_id, changes->>'event' as event,
               changes->>'reason' as reason,
               changes->>'resultingExposure' as resulting_exposure,
               changes->>'creditLimit' as credit_limit
          from audit_log
         where org_id = ${org.orgId}
           and table_name = 'documents'
           and row_id = ${order.id}
           and action = 'approve'
         order by at desc
         limit 1
      `)).rows[0]!;
      assert.deepEqual(evidence, {
        id: evidence.id,
        actor_id: approverId,
        event: "sales_order_credit_override",
        reason: "Customer deposit confirmed by treasury",
        resulting_exposure: "20.0000",
        credit_limit: "10.0000",
      });
      await assert.rejects(
        db.execute(sql`
          update audit_log set changes = '{}'::jsonb
           where id = ${evidence.id} and org_id = ${org.orgId}
        `),
        /audit|immutable|update/i,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
