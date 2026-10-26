import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { appBaseUrl, PREBILL_SUBJECT_KIND } from "@openbooks/engine/flows";
import { isFeatureEnabled } from "./features";
import {
  PORTAL_ACTOR_ID,
  PORTAL_REVIEW_INVITE_TTL_DAYS,
  currentBillingReviewDigest,
  issuePortalReviewInvite,
  recordPortalEvent,
} from "@openbooks/engine/portal";
import {
  billingReviewRequestEmail,
  deriveEmailDeliveryKey,
  sendVia,
  emailDeliveryBlockedMessage,
} from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "@openbooks/engine/delivery/email-config";
import { createMoneyFormatter } from "./money-format";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import {
  PreBillingError,
  type PrebillStatus,
  type SubsidiaryScope,
  type Tx,
  appendEvent,
  assertPreBillingEnabled,
  assertPreBillingEnabledTx,
  audit,
} from "./pre-billing-core";
import { lockPrebillForLifecycle } from "./pre-billing-lifecycle";

// ---------------------------------------------------------------------------
// Customer review and delivery
// ---------------------------------------------------------------------------

/** Whether an enabled flow routes pre-billing approvals for this organization. */
export async function prebillApprovalFlowsConfigured(orgId: string): Promise<boolean> {
  const row = (
    await db.execute<{ configured: boolean }>(
      sql`
    select exists (
      select 1 from flows
       where org_id = ${orgId} and subject_kind = ${PREBILL_SUBJECT_KIND} and enabled
    ) as configured
  `,
      "objects",
    )
  )[0];
  return row?.configured === true;
}

export interface SendPrebillToCustomerInput {
  to?: string | null;
  message?: string | null;
}

export interface SendPrebillToCustomerResult {
  id: string;
  status: PrebillStatus;
  emailed: boolean;
  recipient: string;
  emailError: string | null;
}

type CustomerReviewContext = {
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  project_name: string;
  worksheet_number: string;
  period_start: string | null;
  period_end: string;
  proposed_bill_amount: string;
  currency: string | null;
  customer_decision: string | null;
};

async function customerRecipientEmail(
  tx: Tx,
  orgId: string,
  customerId: string,
): Promise<string | null> {
  const row = (
    await tx.execute<{ email: string | null }>(
      sql`
    select coalesce(
      nullif(btrim(party.email), ''),
      (select nullif(btrim(contact.email), '') from contacts contact
        where contact.org_id = party.org_id and contact.party_id = party.id
          and contact.is_active and nullif(btrim(contact.email), '') is not null
        order by contact.is_primary desc, contact.created_at
        limit 1)
    ) as email
      from parties party
     where party.org_id = ${orgId} and party.id = ${customerId}
  `,
      "objects",
    )
  )[0];
  return row?.email ?? null;
}

/**
 * Send an approved worksheet to its customer for review in the customer
 * portal. The worksheet freezes in `customer_review` with a fingerprint of
 * exactly what the customer is shown; the customer then accepts it (which
 * returns it to approved, ready to invoice) or disputes lines (which returns
 * it to draft). The invitation email is sent after the state commits: an
 * email failure leaves the review open in the portal and is reported, never
 * rolled into a silent success.
 */
export async function sendPrebillToCustomer(
  orgId: string,
  actorId: string,
  id: string,
  input: SendPrebillToCustomerInput,
  scope: SubsidiaryScope = null,
): Promise<SendPrebillToCustomerResult> {
  if (!(await isFeatureEnabled(orgId, "customerPortal"))) {
    throw new PreBillingError(
      "Customer review runs in the customer portal — turn on Customer portal on Company Settings → Features first",
    );
  }
  const prepared = await withOrgTransaction(orgId, async () =>
    db.transaction(async (tx) => {
      await assertPreBillingEnabledTx(tx, orgId);
      const header = await lockPrebillForLifecycle(tx, orgId, id, scope);
      if (header.status !== "approved") {
        throw new PreBillingError(
          `Only an approved prebill can be sent for customer review; this one is ${header.status}`,
        );
      }
      const context = (
        await tx.execute<CustomerReviewContext>(
          sql`
      select project.customer_id, customer.display_name as customer_name, null::text as customer_email,
             project.name as project_name, worksheet.worksheet_number,
             worksheet.period_start::text as period_start, worksheet.period_end::text as period_end,
             worksheet.proposed_bill_amount::text as proposed_bill_amount,
             coalesce(subsidiary.base_currency, org.base_currency) as currency,
             worksheet.customer_decision
        from prebills worksheet
        join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
        join orgs org on org.id = worksheet.org_id
        left join subsidiaries subsidiary on subsidiary.org_id = project.org_id and subsidiary.id = project.subsidiary_id
        left join parties customer on customer.org_id = project.org_id and customer.id = project.customer_id
       where worksheet.org_id = ${orgId} and worksheet.id = ${id}
    `,
          "objects",
        )
      )[0]!;
      if (!context.customer_id)
        throw new PreBillingError("The project has no customer to review this billing");
      if (context.customer_decision === "accepted") {
        throw new PreBillingError(
          "The customer has already accepted this prebill — create the invoice",
        );
      }
      if (!context.currency)
        throw new PreBillingError("The project subsidiary has no functional currency");
      const recipient =
        input.to?.trim() || (await customerRecipientEmail(tx, orgId, context.customer_id));
      if (!recipient) {
        throw new PreBillingError(
          "The customer has no email address — add one to the customer or a contact, or enter one when sending",
        );
      }
      const digest = await currentBillingReviewDigest(orgId, id, tx);
      if (!digest) throw new PreBillingError("Prebill not found", 404);
      const updated = await tx.execute<never>(sql`
      update prebills
         set status = 'customer_review',
             customer_decision = null, customer_decided_at = null, customer_signer_name = null,
             customer_decision_note = null,
             customer_review_sent_at = now(), customer_review_sent_by = ${actorId},
             customer_review_digest = ${digest}, customer_viewed_at = null,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id} and status = 'approved'
    `);
      if ((updated.rowCount ?? 0) !== 1)
        throw new PreBillingError("The prebill changed while sending; reload and try again", 409);
      await tx.execute(sql`
      update prebill_lines set customer_dispute_note = null
       where org_id = ${orgId} and prebill_id = ${id} and customer_dispute_note is not null
    `);
      const invite = await issuePortalReviewInvite(orgId, context.customer_id, recipient, tx);
      await appendEvent(tx, orgId, id, actorId, "customer_review_sent", { digest });
      await audit(tx, orgId, "prebills", id, actorId, {
        before: { status: "approved" },
        after: { status: "customer_review", customerReviewDigest: digest },
      });
      return { context, recipient, token: invite.token };
    }),
  );

  const { context, recipient, token } = prepared;
  const delivery = await resolveOrgEmailTransportDetailed(orgId);
  const orgName = (
    await db.execute<{ name: string; portal_name: string | null }>(
      sql`
    select org.name,
           (select settings.portal_name from customer_portal_settings settings
             where settings.org_id = org.id and settings.effective_from <= current_date
             order by settings.effective_from desc limit 1) as portal_name
      from orgs org where org.id = ${orgId}
  `,
      "objects",
    )
  )[0];
  let emailError: string | null = null;
  if (delivery.state !== "ready") {
    emailError = `${emailDeliveryBlockedMessage(delivery)} The review is waiting in the customer portal.`;
  } else {
    const transport = delivery.transport;
    const mail = billingReviewRequestEmail({
      orgName: orgName?.name ?? "OpenBooks",
      portalName: orgName?.portal_name ?? "Customer portal",
      partyName: context.customer_name,
      reference: context.worksheet_number,
      projectName: context.project_name,
      periodLabel: context.period_start
        ? `${context.period_start} – ${context.period_end}`
        : `work through ${context.period_end}`,
      amount: createMoneyFormatter("en", context.currency!).money(context.proposed_bill_amount),
      reviewUrl: `${appBaseUrl()}/portal/${token}?review=${id}`,
      expiresDays: PORTAL_REVIEW_INVITE_TTL_DAYS,
      message: input.message ?? undefined,
    });
    const logId = await insertEmailLog({
      orgId,
      recipients: [recipient],
      subject: mail.subject,
      status: "queued",
      categoryKey: "portal",
      meta: { event: "billing_review_request", prebillId: id },
      actor: { kind: "user", userId: actorId },
    });
    try {
      const outcome = await sendVia(
        transport,
        { to: recipient, subject: mail.subject, html: mail.html, text: mail.text },
        {
          deliveryKey: deriveEmailDeliveryKey({ orgId, scope: `direct:${logId}`, to: recipient }),
        },
      );
      if (outcome.kind === "sent") {
        await markEmailSent(orgId, logId, outcome.providerMessageId);
      } else {
        await markEmailUncertain(orgId, logId, outcome.reason);
        emailError = `The email provider did not confirm delivery (${outcome.reason}); the review is waiting in the customer portal`;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await markEmailFailed(orgId, logId, reason);
      emailError = `The review email could not be sent (${reason}); the review is waiting in the customer portal`;
    }
    await withOrgTransaction(orgId, async () =>
      db.transaction(async (tx) => {
        await appendEvent(
          tx,
          orgId,
          id,
          actorId,
          emailError ? "customer_review_email_failed" : "customer_review_emailed",
          {
            emailLogId: logId,
            ...(emailError ? { reason: emailError } : {}),
          },
        );
      }),
    );
  }
  return { id, status: "customer_review", emailed: emailError === null, recipient, emailError };
}

export interface PortalReviewDecisionBase {
  orgId: string;
  partyId: string;
  linkId: string;
  prebillId: string;
  /** The fingerprint the customer's page was rendered from. */
  digest: string;
}

type PortalReviewTarget = {
  status: PrebillStatus;
  worksheet_number: string;
  customer_review_digest: string | null;
  notify_user_ids: string[];
};

/** Lock a worksheet the session customer is reviewing, or refuse as not found. */
async function lockPortalReview(
  tx: Tx,
  input: PortalReviewDecisionBase,
): Promise<PortalReviewTarget> {
  await assertPreBillingEnabledTx(tx, input.orgId);
  const target = (
    await tx.execute<PortalReviewTarget>(
      sql`
    select worksheet.status, worksheet.worksheet_number, worksheet.customer_review_digest,
           array_remove(array[worksheet.customer_review_sent_by, worksheet.submitted_by, worksheet.created_by], null)::text[] as notify_user_ids
      from prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
     where worksheet.org_id = ${input.orgId} and worksheet.id = ${input.prebillId}
       and project.customer_id = ${input.partyId}
     for update of worksheet
  `,
      "objects",
    )
  )[0];
  if (!target || target.status !== "customer_review") {
    throw new PreBillingError("This billing is no longer awaiting your review", 404);
  }
  const current = await currentBillingReviewDigest(input.orgId, input.prebillId, tx);
  if (!current || current !== target.customer_review_digest || current !== input.digest) {
    throw new PreBillingError(
      "This billing changed after you opened it — reload the page to review the current version",
      409,
    );
  }
  return target;
}

async function notifyPrebillTeam(
  tx: Tx,
  orgId: string,
  userIds: string[],
  prebillId: string,
  title: string,
  body: string,
) {
  // Notify the people who prepared, submitted and sent the worksheet. One who
  // has since left has no inbox; the worksheet trail still records the decision.
  await tx.execute(sql`
    insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
    select ${orgId}, member.id, 'pre_billing', ${title}, ${body}, ${`/projects/pre-billing?prebill=${prebillId}`},
           ${PORTAL_ACTOR_ID}::uuid, ${PORTAL_ACTOR_ID}::uuid
      from users member
     where member.id in (select jsonb_array_elements_text(${JSON.stringify([...new Set(userIds)])}::jsonb)::uuid)
  `);
}

/**
 * The customer accepts the package as shown. Acceptance names the signer and
 * may carry the customer's purchase order number, which the invoice then
 * references. The worksheet returns to approved, ready to invoice.
 */
export async function acceptPrebillReview(
  input: PortalReviewDecisionBase & {
    signerName: string;
    purchaseOrderNumber?: string | null;
    note?: string | null;
  },
) {
  const signerName = input.signerName.trim();
  if (!signerName) throw new PreBillingError("Enter your name to accept this billing");
  if (signerName.length > 200)
    throw new PreBillingError("The name is too long — at most 200 characters");
  const po = input.purchaseOrderNumber?.trim() || null;
  if (po && po.length > 100)
    throw new PreBillingError("The purchase order number is too long — at most 100 characters");
  const note = input.note?.trim() || null;
  if (note && note.length > 2000)
    throw new PreBillingError("The comment is too long — at most 2,000 characters");
  return withOrgTransaction(input.orgId, async () =>
    db.transaction(async (tx) => {
      const target = await lockPortalReview(tx, input);
      await tx.execute(sql`
      update prebills
         set status = 'approved', customer_decision = 'accepted', customer_decided_at = now(),
             customer_signer_name = ${signerName}, customer_decision_note = ${note},
             customer_po_number = coalesce(${po}, customer_po_number),
             updated_at = now(), updated_by = ${PORTAL_ACTOR_ID}::uuid
       where org_id = ${input.orgId} and id = ${input.prebillId} and status = 'customer_review'
    `);
      await appendEvent(tx, input.orgId, input.prebillId, PORTAL_ACTOR_ID, "customer_accepted", {
        digest: input.digest,
        purchaseOrderProvided: po !== null,
        commented: note !== null,
      });
      await audit(tx, input.orgId, "prebills", input.prebillId, PORTAL_ACTOR_ID, {
        before: { status: "customer_review" },
        after: { status: "approved", customerDecision: "accepted" },
        source: "customer_portal",
      });
      await recordPortalEvent(tx, input.orgId, {
        partyId: input.partyId,
        linkId: input.linkId,
        action: "billing_review_accepted",
        reasonCode: null,
        detail: { prebillId: input.prebillId },
      });
      await notifyPrebillTeam(
        tx,
        input.orgId,
        target.notify_user_ids,
        input.prebillId,
        `Customer accepted ${target.worksheet_number}`,
        po ? `Ready to invoice. Purchase order ${po} was provided.` : "Ready to invoice.",
      );
      return { id: input.prebillId, status: "approved" as PrebillStatus };
    }),
  );
}

/**
 * The customer disputes the package. Each disputed line carries the
 * customer's note; the worksheet returns to draft so the preparer can adjust,
 * hold or explain the lines and send it through approval again.
 */
export async function disputePrebillReview(
  input: PortalReviewDecisionBase & {
    note?: string | null;
    lines: Array<{ lineId: string; note: string }>;
  },
) {
  const note = input.note?.trim() || null;
  if (note && note.length > 2000)
    throw new PreBillingError("The comment is too long — at most 2,000 characters");
  const lines = input.lines
    .map((line) => ({ lineId: line.lineId, note: line.note.trim() }))
    .filter((line) => line.note.length > 0);
  if (lines.length === 0 && !note) {
    throw new PreBillingError(
      "Tell us what needs attention — add a note to at least one line or a general comment",
    );
  }
  if (lines.some((line) => line.note.length > 1000)) {
    throw new PreBillingError("A line note is too long — at most 1,000 characters");
  }
  return withOrgTransaction(input.orgId, async () =>
    db.transaction(async (tx) => {
      const target = await lockPortalReview(tx, input);
      for (const line of lines) {
        const updated = await tx.execute<never>(sql`
        update prebill_lines set customer_dispute_note = ${line.note}
         where org_id = ${input.orgId} and prebill_id = ${input.prebillId} and id = ${line.lineId}
           and disposition = 'bill'
      `);
        if ((updated.rowCount ?? 0) !== 1) {
          throw new PreBillingError(
            "A disputed line is not part of this billing — reload the page and try again",
            409,
          );
        }
      }
      await tx.execute(sql`
      update prebills
         set status = 'draft', approved_at = null, approved_by = null,
             customer_decision = 'disputed', customer_decided_at = now(),
             customer_signer_name = null, customer_decision_note = ${note},
             updated_at = now(), updated_by = ${PORTAL_ACTOR_ID}::uuid
       where org_id = ${input.orgId} and id = ${input.prebillId} and status = 'customer_review'
    `);
      await appendEvent(tx, input.orgId, input.prebillId, PORTAL_ACTOR_ID, "customer_disputed", {
        digest: input.digest,
        disputedLines: lines.length,
        commented: note !== null,
      });
      await audit(tx, input.orgId, "prebills", input.prebillId, PORTAL_ACTOR_ID, {
        before: { status: "customer_review" },
        after: { status: "draft", customerDecision: "disputed" },
        source: "customer_portal",
      });
      await recordPortalEvent(tx, input.orgId, {
        partyId: input.partyId,
        linkId: input.linkId,
        action: "billing_review_disputed",
        reasonCode: null,
        detail: { prebillId: input.prebillId, disputedLines: lines.length },
      });
      await notifyPrebillTeam(
        tx,
        input.orgId,
        target.notify_user_ids,
        input.prebillId,
        `Customer disputed ${target.worksheet_number}`,
        lines.length > 0
          ? `${lines.length} line${lines.length === 1 ? "" : "s"} need attention. The prebill is back in draft.`
          : "The prebill is back in draft with the customer's comment.",
      );
      return { id: input.prebillId, status: "draft" as PrebillStatus };
    }),
  );
}

/** Record the first time the customer opens a package sent to them. */
export async function markPrebillViewedByCustomer(
  orgId: string,
  partyId: string,
  prebillId: string,
) {
  await withOrgTransaction(orgId, async () =>
    db.transaction(async (tx) => {
      const marked = (
        await tx.execute<{ id: string }>(
          sql`
      update prebills worksheet
         set customer_viewed_at = now()
        from projects project
       where worksheet.org_id = ${orgId} and worksheet.id = ${prebillId}
         and project.org_id = worksheet.org_id and project.id = worksheet.project_id
         and project.customer_id = ${partyId}
         and worksheet.customer_viewed_at is null
         and worksheet.customer_review_sent_at is not null
      returning worksheet.id
    `,
          "objects",
        )
      )[0];
      if (marked) await appendEvent(tx, orgId, prebillId, PORTAL_ACTOR_ID, "customer_viewed");
    }),
  );
}

/**
 * Email the invoice a worksheet produced to the customer with its backup
 * packet attached, and record the delivery on the worksheet. Only a posted
 * invoice is delivered. When the invoice's billing request requires backup,
 * the stored packet must exist — the same rule that guards issuing it.
 */
export async function deliverPrebillInvoice(
  orgId: string,
  actorId: string,
  id: string,
  input: { to?: string | null; message?: string | null },
  scope: SubsidiaryScope = null,
) {
  await assertPreBillingEnabled(orgId);
  const row = (
    await db.execute<{
      status: PrebillStatus;
      invoice_id: string | null;
      invoice_status: string | null;
      invoice_number: string | null;
    }>(
      sql`
    select worksheet.status, worksheet.invoice_document_id as invoice_id,
           invoice.status as invoice_status, invoice.document_number as invoice_number
      from prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
      left join documents invoice on invoice.org_id = worksheet.org_id and invoice.id = worksheet.invoice_document_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
  `,
      "objects",
    )
  )[0];
  if (!row) throw new PreBillingError("Prebill not found", 404);
  if (row.status !== "converted" || !row.invoice_id)
    throw new PreBillingError("Create the invoice before sending it");
  if (row.invoice_status !== "posted") {
    throw new PreBillingError(
      `Post invoice ${row.invoice_number ?? ""} before sending it to the customer`.replace(
        "  ",
        " ",
      ),
    );
  }
  // Delivery pulls in the PDF and file-cabinet graph only when it runs.
  const [{ loadInvoiceBackup, requireInvoiceBackup }, { sendRecordPdfEmail }] = await Promise.all([
    import("./invoice-backup"),
    import("./pdf-templates/send"),
  ]);
  try {
    await requireInvoiceBackup(orgId, row.invoice_id);
  } catch (error) {
    // The backup refusal names its remedy; surface it as this command's refusal.
    if (error instanceof Error && "code" in error && error.code === "invoice_backup_required") {
      throw new PreBillingError(error.message);
    }
    throw error;
  }
  const backup = await loadInvoiceBackup(orgId, row.invoice_id, scope);
  const sent = await sendRecordPdfEmail({
    recordType: "customer_invoice",
    orgId,
    id: row.invoice_id,
    to: input.to ?? undefined,
    message: input.message ?? undefined,
    scope,
    extraAttachments: backup ? [{ filename: backup.filename, content: backup.bytes }] : [],
  });
  await withOrgTransaction(orgId, async () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`
      update prebills
         set delivered_at = now(), delivered_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id} and status = 'converted'
    `);
      await appendEvent(tx, orgId, id, actorId, "delivered", { backupAttached: backup !== null });
    }),
  );
  return { id, to: sent.to, backupAttached: backup !== null };
}
