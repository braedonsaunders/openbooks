import "server-only";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "@openbooks/engine/delivery/email-config/module";
import {
  deriveEmailDeliveryKey,
  documentEmail,
  isValidEmailAddress,
  sendVia,
  emailDeliveryBlockedMessage,
} from "@openbooks/emails";
import { can, subsidiaryScopeAllows, type Authz } from "@/lib/authz";
import { notFound } from "@/lib/api/responses";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isUuid } from "@/lib/list-params";
import { parseReportQuery } from "@/lib/report-filters";
import { resolvePeriod } from "@/lib/periods";
import { resolveReport, type ReportKind } from "@/lib/report-run";
import { exportDataToPdf, orgBranding, resolveLayout, type Translator } from "@/lib/report-pdf";
import { safeName } from "@/lib/export";
import { pickStatementEmail } from "@/lib/statement-batch";

export type StatementSide = "ar" | "ap";

export async function loadStatementParty(orgId: string, id: string) {
  const rows = await db.execute<{
    id: string;
    display_name: string | null;
    email: string | null;
    subsidiary_id: string | null;
  }>(
    sql`select id, display_name, email, subsidiary_id from parties where id = ${id} and org_id = ${orgId} limit 1`,
    "objects",
  );
  return rows[0] ?? null;
}

export async function statementRecipient(
  orgId: string,
  party: { id: string; email: string | null },
): Promise<string | null> {
  const contacts = await db.execute<{
    role: string | null;
    email: string | null;
    isPrimary: boolean;
    isActive: boolean;
  }>(
    sql`select role, email, is_primary as "isPrimary", is_active as "isActive"
      from contacts where org_id = ${orgId} and party_id = ${party.id}`,
    "objects",
  );
  return pickStatementEmail(contacts, party.email);
}

export function statementPartyInScope(
  allowedSubsidiaryIds: Set<string> | null,
  party: { subsidiary_id: string | null },
): boolean {
  return subsidiaryScopeAllows(allowedSubsidiaryIds, party.subsidiary_id, { orgWideNull: true });
}

export async function sendPartyStatement(
  authz: Authz,
  id: string,
  body: {
    side: StatementSide;
    to?: string;
    message?: string;
    from?: string;
    toDate?: string;
  },
): Promise<NextResponse | { ok: true; to: string }> {
  const side = body.side;
  const sendPermission = side === "ap" ? "ap.create" : "ar.create";
  if (!can(authz, sendPermission)) {
    return NextResponse.json({ error: `missing permission: ${sendPermission}` }, { status: 403 });
  }
  if (!can(authz, "reports.read")) {
    return NextResponse.json({ error: "missing permission: reports.read" }, { status: 403 });
  }
  if (!isUuid(id)) return notFound("record");
  const party = await loadStatementParty(authz.user.orgId, id);
  if (!party || !statementPartyInScope(authz.allowedSubsidiaryIds, party))
    return notFound("record");

  const requestedTo = typeof body.to === "string" ? body.to.trim() : "";
  if (requestedTo !== "" && !isValidEmailAddress(requestedTo)) {
    return NextResponse.json({ error: "invalid recipient email address" }, { status: 400 });
  }
  const to = requestedTo || (await statementRecipient(authz.user.orgId, party)) || "";
  if (!to) {
    return NextResponse.json(
      {
        error:
          "no recipient email — add a billing, statement, primary contact, or party email first",
      },
      { status: 422 },
    );
  }
  const delivery = await resolveOrgEmailTransportDetailed(authz.user.orgId);
  if (delivery.state !== "ready") {
    return NextResponse.json({ error: emailDeliveryBlockedMessage(delivery) }, { status: 422 });
  }
  const t = (await getTranslations("reports")) as unknown as Translator;
  const stamp = await businessToday(authz.user.orgId);
  const reportParams = new URLSearchParams({ party: id, side });
  const fromDate = body.from || body.toDate;
  if (typeof fromDate === "string" && fromDate) reportParams.set("from", fromDate);
  if (typeof body.toDate === "string" && body.toDate) reportParams.set("to", body.toDate);
  const query = parseReportQuery(reportParams);
  const period = await resolvePeriod(query.period, { customFrom: query.from, customTo: query.to });
  let pdf: Buffer;
  let orgName = "OpenBooks";
  try {
    const resolved = await resolveReport("partner-statement" as ReportKind, reportParams, {
      orgId: authz.user.orgId,
      t,
      period,
      query,
    });
    if (resolved.render !== "data") throw new Error("statement failed");
    const branding = await orgBranding(authz.user.orgId);
    orgName = branding.orgName || orgName;
    const { page, showSummary } = resolveLayout(null);
    pdf = Buffer.from(
      await exportDataToPdf(resolved.data, branding, page, {
        showSummary,
        generatedAt: new Date(`${stamp}T00:00:00Z`),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }

  const partyName = party.display_name?.trim() || undefined;
  const attachmentName = `${safeName(`statement-${party.display_name ?? "party"}-${period.to}`)}.pdf`;
  const email = documentEmail({
    orgName,
    docTitle: "Statement",
    reference: `as of ${period.to}`,
    partyName,
    message: typeof body.message === "string" ? body.message : undefined,
    attachmentName,
  });
  const logId = await insertEmailLog({
    orgId: authz.user.orgId,
    recipients: [to],
    subject: email.subject,
    status: "queued",
    categoryKey: "statement",
    meta: { partyId: id, side },
    actor: { kind: "user", userId: authz.user.id },
  });
  let uncertaintyRecorded = false;
  try {
    const outcome = await sendVia(
      delivery.transport,
      {
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: [
          {
            filename: attachmentName,
            content: pdf.toString("base64"),
            contentType: "application/pdf",
          },
        ],
      },
      {
        deliveryKey: deriveEmailDeliveryKey({
          orgId: authz.user.orgId,
          scope: `direct:${logId}`,
          to,
        }),
      },
    );
    if (outcome.kind === "sent") {
      await markEmailSent(authz.user.orgId, logId, outcome.providerMessageId);
    } else {
      uncertaintyRecorded = true;
      await markEmailUncertain(authz.user.orgId, logId, outcome.reason);
      throw new Error(outcome.reason);
    }
  } catch (error) {
    if (!uncertaintyRecorded) {
      await markEmailFailed(
        authz.user.orgId,
        logId,
        error instanceof Error ? error.message : String(error),
      );
    }
    return apiErrorResponse(error);
  }
  return { ok: true, to };
}
