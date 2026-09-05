import { documentRevisionSql, isDocumentRevisionToken } from "./document-revision.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor, withOrgTransaction } from "./db.ts";
import { add, cmp, normalizeMoney } from "./money.ts";
import { actorHasPermission } from "./actor-permissions.ts";
import {
  submitAndReleaseIfUngated,
  type SubmissionReleaseResult,
} from "./flows/index.ts";

export type SalesOrderIssueErrorCode =
  | "SALES_ORDER_NOT_FOUND"
  | "SALES_ORDER_STALE_REVISION"
  | "SALES_ORDER_NOT_DRAFT"
  | "SALES_ORDER_INCOMPLETE"
  | "CUSTOMER_CREDIT_HOLD"
  | "CUSTOMER_CREDIT_CONFIGURATION_INVALID"
  | "CUSTOMER_CREDIT_CURRENCY_MISMATCH"
  | "CUSTOMER_CREDIT_MIXED_CURRENCY_EXPOSURE"
  | "CUSTOMER_CREDIT_LIMIT_EXCEEDED"
  | "CUSTOMER_CREDIT_OVERRIDE_REASON_REQUIRED"
  | "CUSTOMER_CREDIT_OVERRIDE_FORBIDDEN";

export class SalesOrderIssueError extends Error {
  readonly name = "SalesOrderIssueError";

  constructor(
    message: string,
    readonly code: SalesOrderIssueErrorCode,
    readonly status = 422,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export interface SalesOrderCreditDecision {
  currency: string;
  limit: string;
  openOrderExposure: string;
  unpaidInvoiceExposure: string;
  orderAmount: string;
  resultingExposure: string;
  overridden: boolean;
}

export interface IssueSalesOrderResult {
  submission: SubmissionReleaseResult;
  /** Null means the customer role has no configured credit limit. */
  credit: SalesOrderCreditDecision | null;
}

interface SalesOrderRow extends Record<string, unknown> {
  id: string;
  status: string;
  party_id: string | null;
  currency: string;
  total: string;
  updated_at: string;
}

interface CustomerRoleRow extends Record<string, unknown> {
  id: string;
  credit_limit: string | null;
  currency: string | null;
  is_on_hold: boolean;
  hold_reason: string | null;
}

/** Effective permission check for engine-side authority gates: engine/src/actor-permissions.ts. */

/**
 * Authoritative customer credit exposure, measured in customer_roles.currency.
 *
 * Exposure is the sum of:
 *   1. the committed remainder of every pending-approval or approved sales
 *      order: order total less posted, linked customer-invoice totals; and
 *   2. open_balance on posted customer invoices for the customer.
 *
 * The order being issued is then added at its full total. A draft invoice does
 * not prematurely release the commitment: the order remainder drops only when
 * that linked invoice posts, in the same transaction where its open_balance
 * becomes exposure. Customer credits are not assumed to settle invoices: only
 * an applied payment/credit that reduces the invoice's maintained open_balance
 * reduces exposure. No implicit FX conversion is allowed. The order and every
 * existing exposure instrument must use the customer-role currency, otherwise
 * issuance fails closed.
 *
 * The caller must hold the customer_roles row lock acquired below while using
 * this result. That row is the per-customer serialization point: an issue that
 * waits behind another issue re-reads the first issue's committed order.
 */
async function creditDecision(
  tx: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    order: SalesOrderRow;
    creditOverrideReason?: string;
  },
): Promise<SalesOrderCreditDecision | null> {
  const role = (await tx.execute<CustomerRoleRow>(sql`
    select id, credit_limit, currency, is_on_hold, hold_reason
      from customer_roles
     where org_id = ${input.orgId}
       and party_id = ${input.order.party_id}
       and is_active
     for update
  `)).rows[0];
  if (!role) return null;

  if (role.is_on_hold) {
    throw new SalesOrderIssueError(
      `customer is on credit hold${role.hold_reason ? ` — ${role.hold_reason}` : ""}`,
      "CUSTOMER_CREDIT_HOLD",
    );
  }
  if (role.credit_limit === null) return null;
  if (!role.currency) {
    throw new SalesOrderIssueError(
      "customer credit limit has no currency; configure the customer role before issuing",
      "CUSTOMER_CREDIT_CONFIGURATION_INVALID",
    );
  }
  if (cmp(role.credit_limit, "0") < 0) {
    throw new SalesOrderIssueError(
      "customer credit limit cannot be negative; correct the customer role before issuing",
      "CUSTOMER_CREDIT_CONFIGURATION_INVALID",
    );
  }
  if (input.order.currency !== role.currency) {
    throw new SalesOrderIssueError(
      `sales order currency ${input.order.currency} does not match the customer credit-limit currency ${role.currency}`,
      "CUSTOMER_CREDIT_CURRENCY_MISMATCH",
      422,
      { orderCurrency: input.order.currency, creditCurrency: role.currency },
    );
  }

  const mixedCurrency = (await tx.execute<{ kind: string; currency: string }>(sql`
    select exposure.kind, exposure.currency
      from documents exposure
     where exposure.org_id = ${input.orgId}
       and exposure.party_id = ${input.order.party_id}
       and exposure.currency <> ${role.currency}
       and (
         (
           exposure.kind = 'sales_order'
           and exposure.status in ('pending_approval', 'approved')
           and greatest(
             exposure.total - coalesce((
               select sum(billed.total)
                 from document_links link
                 join documents billed
                   on billed.id = link.to_document_id
                  and billed.org_id = link.org_id
                  and billed.kind = 'customer_invoice'
                  and billed.status = 'posted'
                where link.org_id = exposure.org_id
                  and link.from_document_id = exposure.id
             ), 0),
             0
           ) > 0
         )
         or (
           exposure.kind = 'customer_invoice'
           and exposure.status = 'posted'
           and coalesce(exposure.open_balance, 0) > 0
         )
       )
     order by exposure.kind, exposure.id
     limit 1
  `)).rows[0];
  if (mixedCurrency) {
    throw new SalesOrderIssueError(
      `customer has open ${mixedCurrency.kind.replaceAll("_", " ")} exposure in ${mixedCurrency.currency}; credit limit is enforced only in ${role.currency}`,
      "CUSTOMER_CREDIT_MIXED_CURRENCY_EXPOSURE",
      422,
      { exposureCurrency: mixedCurrency.currency, creditCurrency: role.currency },
    );
  }

  const exposure = (await tx.execute<{
    open_order_exposure: string;
    unpaid_invoice_exposure: string;
  }>(sql`
    select
      coalesce((
        select sum(
          greatest(
            issued.total - coalesce((
              select sum(billed.total)
                from document_links link
                join documents billed
                  on billed.id = link.to_document_id
                 and billed.org_id = link.org_id
                 and billed.kind = 'customer_invoice'
                 and billed.status = 'posted'
               where link.org_id = issued.org_id
                 and link.from_document_id = issued.id
            ), 0),
            0
          )
        )
          from documents issued
         where issued.org_id = ${input.orgId}
           and issued.party_id = ${input.order.party_id}
           and issued.kind = 'sales_order'
           and issued.status in ('pending_approval', 'approved')
           and issued.currency = ${role.currency}
      ), 0)::text as open_order_exposure,
      coalesce((
        select sum(invoice.open_balance)
          from documents invoice
         where invoice.org_id = ${input.orgId}
           and invoice.party_id = ${input.order.party_id}
           and invoice.kind = 'customer_invoice'
           and invoice.status = 'posted'
           and invoice.currency = ${role.currency}
           and coalesce(invoice.open_balance, 0) > 0
      ), 0)::text as unpaid_invoice_exposure
  `)).rows[0]!;

  const limit = normalizeMoney(role.credit_limit);
  const openOrderExposure = normalizeMoney(exposure.open_order_exposure);
  const unpaidInvoiceExposure = normalizeMoney(exposure.unpaid_invoice_exposure);
  const orderAmount = normalizeMoney(input.order.total);
  const existingExposure = add(openOrderExposure, unpaidInvoiceExposure);
  const resultingExposure = add(existingExposure, orderAmount);
  const exceeded = cmp(resultingExposure, limit) > 0;
  let overridden = false;

  if (exceeded) {
    const reason = input.creditOverrideReason?.trim() ?? "";
    if (reason.length > 0 && (reason.length < 10 || reason.length > 500)) {
      throw new SalesOrderIssueError(
        "credit override reason must be between 10 and 500 characters",
        "CUSTOMER_CREDIT_OVERRIDE_REASON_REQUIRED",
      );
    }
    if (!reason) {
      throw new SalesOrderIssueError(
        `issuing this order would raise customer credit exposure to ${resultingExposure} ${role.currency}, above the ${limit} ${role.currency} limit`,
        "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
        422,
        {
          currency: role.currency,
          limit,
          existingExposure,
          orderAmount,
          resultingExposure,
        },
      );
    }
    if (!(await actorHasPermission(tx, input.orgId, input.actorId, "ar.approve"))) {
      throw new SalesOrderIssueError(
        "AR approval permission is required to override a customer credit limit",
        "CUSTOMER_CREDIT_OVERRIDE_FORBIDDEN",
        403,
      );
    }
    overridden = true;
  }

  return {
    currency: role.currency,
    limit,
    openOrderExposure,
    unpaidInvoiceExposure,
    orderAmount,
    resultingExposure,
    overridden,
  };
}

/**
 * Issue one sales order through the engine-owned lifecycle boundary.
 *
 * Document locking fences duplicate/stale issue attempts; customer-role
 * locking serializes aggregate credit consumption across different orders.
 * Approval routing and the credit decision commit or roll back together.
 */
export async function issueSalesOrder(input: {
  orgId: string;
  salesOrderId: string;
  actorId: string;
  expectedUpdatedAt: string;
  creditOverrideReason?: string;
}): Promise<IssueSalesOrderResult> {
  return withOrgTransaction(input.orgId, async () => {
    const order = (await db.execute<SalesOrderRow>(sql`
      select id, status, party_id, currency, total, ${documentRevisionSql(sql`updated_at`)} as updated_at
        from documents
       where id = ${input.salesOrderId}
         and org_id = ${input.orgId}
         and kind = 'sales_order'
       for update
    `)).rows[0];
    if (!order) {
      throw new SalesOrderIssueError(
        "sales order not found",
        "SALES_ORDER_NOT_FOUND",
        404,
      );
    }
    if (!isDocumentRevisionToken(input.expectedUpdatedAt) || input.expectedUpdatedAt !== order.updated_at) {
      throw new SalesOrderIssueError(
        "this order changed after you opened it; reload and review the latest revision",
        "SALES_ORDER_STALE_REVISION",
        409,
      );
    }
    if (order.status !== "draft") {
      throw new SalesOrderIssueError(
        "only a draft can be issued",
        "SALES_ORDER_NOT_DRAFT",
      );
    }
    if (!order.party_id || cmp(order.total, "0") <= 0) {
      throw new SalesOrderIssueError(
        "Add a party and at least one line before issuing",
        "SALES_ORDER_INCOMPLETE",
      );
    }

    const credit = await creditDecision(db, {
      orgId: input.orgId,
      actorId: input.actorId,
      order,
      creditOverrideReason: input.creditOverrideReason,
    });
    const submission = await submitAndReleaseIfUngated(
      "sales_order",
      input.salesOrderId,
      input.actorId,
    );

    if (credit?.overridden && !submission.flowError) {
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${input.orgId}, 'documents', ${input.salesOrderId}, 'approve',
          ${JSON.stringify({
            event: "sales_order_credit_override",
            reason: input.creditOverrideReason!.trim(),
            currency: credit.currency,
            creditLimit: credit.limit,
            openOrderExposure: credit.openOrderExposure,
            unpaidInvoiceExposure: credit.unpaidInvoiceExposure,
            orderAmount: credit.orderAmount,
            resultingExposure: credit.resultingExposure,
          })}::jsonb,
          ${input.actorId}
        )
      `);
    }

    return { submission, credit };
  });
}
