import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  CLOSE_DELIVERY_QUEUE,
  enqueueEmail,
  getBlockingConnection,
  newEmailIntentKey,
  type CloseDeliveryJobData,
  type EnqueueEmailData,
  type EnqueueEmailOptions,
} from "@openbooks/jobs";
import { isValidEmailAddress } from "@openbooks/emails";
import { storeEmailAttachments } from "../delivery/email-attachments.ts";
import {
  settleStagedAttachmentsAfterEnqueueError,
  type EmailQueuedJobProbe,
} from "../delivery/email-enqueue-settlement.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { db, withOrgContext } from "../platform/db.ts";
import { ensureReportDefinitions } from "../reports/ensure-report-definitions.ts";
import { renderReportPdf } from "./render-client.ts";

/**
 * One attached report's render, injectable for tests; production renders
 * through the web app's internal render endpoint (rendering lives in
 * web/lib, which the engine cannot import). Same seam shape as the
 * report worker's renderer and the flow-email enqueuer: callers that
 * drive the worker without HTTP or Redis inject fakes.
 */
export type CloseReportRenderer = (
  orgId: string,
  definitionId: string,
  params: Record<string, string>,
) => Promise<Buffer>;

export type CloseEmailEnqueuer = (
  data: EnqueueEmailData,
  options: EnqueueEmailOptions,
) => Promise<unknown>;

export type CloseDeliveryDeps = {
  probeQueuedJob?: EmailQueuedJobProbe;
  renderReport?: CloseReportRenderer;
  enqueueEmail?: CloseEmailEnqueuer;
};

/** Per-report override captured on the package (mirrors the UI attachment). */
type Attachment = {
  slug: string;
  period?: string;
  from?: string;
  to?: string;
  breakout?: string;
  departmentId?: string;
  locationId?: string;
  classId?: string;
  projectId?: string;
  subsidiaryId?: string;
};

// Email delivery caps attachments at 10 files / 10 MiB total.
const MAX_REPORTS = 10;

function normalizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Attachment => Boolean(item && typeof item === "object" && (item as Attachment).slug));
}

/** Translate an attachment's overrides into the report render endpoint's query
 * params (the report-filters codec keys). `$close` / no period resolves to the
 * concrete date range of the period being closed. */
function renderParams(attachment: Attachment, closeFrom: string, closeTo: string, format: string): Record<string, string> {
  const params: Record<string, string> = {};
  const period = attachment.period ?? "$close";
  if (period === "$close") {
    params.period = "custom";
    params.from = closeFrom;
    params.to = closeTo;
  } else if (period === "custom") {
    params.period = "custom";
    if (attachment.from) params.from = attachment.from;
    if (attachment.to) params.to = attachment.to;
  } else {
    params.period = period;
  }
  if (attachment.breakout && attachment.breakout !== "none") params.breakout = attachment.breakout;
  if (attachment.departmentId) params.dept = attachment.departmentId;
  if (attachment.locationId) params.location = attachment.locationId;
  if (attachment.classId) params.class = attachment.classId;
  if (attachment.projectId) params.project = attachment.projectId;
  if (attachment.subsidiaryId) params.sub = attachment.subsidiaryId;
  if (format === "xlsx") params.format = "xlsx";
  return params;
}

function escapeHtml(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(value: string, fallback: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || fallback;
}

/** Concatenate rendered report PDFs into a single document (delivery.combine). */
async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (const buffer of buffers) {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return Buffer.from(await out.save());
}

type PackageContext = {
  period_name: string;
  starts_on: string;
  ends_on: string;
  book_name: string;
  package_name: string;
  reports: unknown;
  recipients: unknown;
  delivery: Record<string, unknown> | null;
  package_author: string | null;
  org_name: string;
};

type ReportDefinitionForRun = {
  slug: string;
  id: string;
  name: string;
  reportType: string;
  query: unknown;
  statement: unknown;
  kind: string;
};

/**
 * Mint one close-package report run row per attached report and return its
 * id for the render call. The internal render route refuses renders without
 * a run id (it authorizes every background render against a durable run),
 * so rendering straight at a definition id 422s and no close package ever
 * delivered. The row pins the send principal (the publish or send-now
 * actor, falling back to the package author) with their current subsidiary
 * scope and the definition as it stands; the route re-resolves that
 * principal's grants at render time, exactly like a scheduled run.
 */
async function mintCloseReportRun(
  orgId: string,
  definition: ReportDefinitionForRun,
  params: Record<string, string>,
  closePackage: { packageId: string; runId: string | null },
  principal: string,
): Promise<string> {
  const allowed = await actorAllowedSubsidiaryIds(db, orgId, principal);
  const rows = (await db.execute<{ id: string }>(sql`
    insert into report_runs
      (org_id, definition_id, trigger, status, recipient_emails, filters,
       authorization_snapshot, created_by)
    values (${orgId}, ${definition.id}, 'close-package', 'running', '[]'::jsonb,
            ${JSON.stringify({ statementParams: params, closePackage })}::jsonb,
            ${JSON.stringify({
              version: 1,
              userId: principal,
              allowedSubsidiaryIds: allowed === null ? null : [...allowed].sort(),
              // No requiredPermissions at mint: the render route records
              // the content-derived key once at render (the single
              // transition the evidence trigger admits), after re-checking
              // the principal's grants against the rendered content.
              definition: {
                report_type: definition.reportType,
                query: definition.query,
                statement: definition.statement,
                name: definition.name,
                slug: definition.slug,
                kind: definition.kind,
              },
            })}::jsonb, ${principal})
    returning id::text as id`)).rows;
  // A write matching zero rows is a failure, not a success.
  if (!rows[0]) {
    throw new Error(
      `close package report run was not recorded for ${definition.slug} — nothing was rendered; retry the delivery`,
    );
  }
  return rows[0].id;
}

/** Load the period/book/package context from either a published close run or an
 * explicit period + book (manual "Send now"). */
async function loadContext(data: {
  orgId: string;
  packageId: string;
  runId?: string;
  periodId?: string;
  bookId?: string;
}): Promise<PackageContext | undefined> {
  const { orgId, packageId, runId, periodId, bookId } = data;
  const select = sql`p.name as period_name, p.starts_on, p.ends_on, b.name as book_name,
           pkg.name as package_name, pkg.reports, pkg.recipients, pkg.delivery,
           pkg.created_by as package_author, o.name as org_name`;
  const rows = runId
    ? ((await db.execute<PackageContext>(sql`
        select ${select}
          from close_runs r
          join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
          join accounting_books b on b.id = r.book_id and b.org_id = r.org_id
          join close_reporting_packages pkg on pkg.id = ${packageId} and pkg.org_id = ${orgId}
          join orgs o on o.id = r.org_id
         where r.id = ${runId} and r.org_id = ${orgId}`))).rows
    : ((await db.execute<PackageContext>(sql`
        select ${select}
          from accounting_periods p
          join accounting_books b on b.id = ${bookId} and b.org_id = ${orgId}
          join close_reporting_packages pkg on pkg.id = ${packageId} and pkg.org_id = ${orgId}
          join orgs o on o.id = ${orgId}
         where p.id = ${periodId} and p.org_id = ${orgId}`))).rows;
  return rows[0];
}

/**
 * Execute one `close-delivery` queue payload — the exact code the worker
 * callback runs, extracted (same function, no shadow) so tests can drive a
 * real payload through it against live Postgres without standing up Redis.
 */
export async function processCloseDeliveryJobData(
  data: CloseDeliveryJobData,
  deps: CloseDeliveryDeps = {},
): Promise<unknown> {
      const { orgId, runId } = data;
      const renderReport: CloseReportRenderer = deps.renderReport
        ?? ((renderOrgId, definitionId, params) => renderReportPdf(renderOrgId, definitionId, params));
      const enqueue: CloseEmailEnqueuer = deps.enqueueEmail ?? enqueueEmail;
      // Queue callbacks carry no request store; the package's tenant is the
      // only legal scope for the context load, catalog ensure, and close event.
      return await withOrgContext(orgId, async () => {
      const row = await loadContext(data);
      if (!row) throw new Error("close run / period or reporting package not found");

      const delivery = (row.delivery ?? {}) as Record<string, unknown>;
      if (delivery.cadence === "manual") return { skipped: "manual cadence" };

      const recipients = (Array.isArray(row.recipients) ? row.recipients : []).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (recipients.length === 0) return { skipped: "no recipients" };
      // Fail closed before any render work: the queue's provider validation
      // throws on the first invalid address, so letting one through burns a
      // full render pass and all three queue attempts while the package is
      // never delivered. The save boundary refuses these first; this guards
      // rows that predate it or arrived outside the UI.
      const invalidRecipients = recipients.filter((recipient) => !isValidEmailAddress(recipient));
      if (invalidRecipients.length > 0) {
        throw new Error(`reporting package has invalid recipients: ${invalidRecipients.join(", ")}`);
      }

      const attachmentsSpec = normalizeAttachments(row.reports);
      if (attachmentsSpec.length === 0) return { skipped: "no reports" };
      const truncated = attachmentsSpec.length > MAX_REPORTS;
      const specs = attachmentsSpec.slice(0, MAX_REPORTS);

      // The send principal authorizes every render: the publish or
      // send-now actor, falling back to the package author for sends
      // enqueued before the principal travelled on the job.
      const principal = data.senderId ?? row.package_author;
      if (!principal) {
        throw new Error(
          `reporting package ${data.packageId} has no recorded sender — re-save the package or re-send it so delivery carries its authorizing principal`,
        );
      }

      // Guarantee every catalog slug (statements + built-ins) resolves to an id.
      await ensureReportDefinitions(orgId);
      const defs = (await db.execute<ReportDefinitionForRun>(sql`
        select slug, id::text as id, name, report_type as "reportType", query, statement, kind
          from report_definitions
         where org_id = ${orgId} and slug in (${sql.join(specs.map((spec) => sql`${spec.slug}`), sql`, `)})`));
      const defBySlug = new Map(defs.rows.map((def) => [def.slug, def]));

      const xlsxType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const format = delivery.format === "xlsx" ? "xlsx" : "pdf";
      const rendered: Array<{ name: string; bytes: Buffer }> = [];
      const failures: string[] = [];
      const dateTag = String(row.ends_on);
      for (const spec of specs) {
        const def = defBySlug.get(spec.slug);
        if (!def) {
          failures.push(spec.slug);
          continue;
        }
        const params = renderParams(spec, String(row.starts_on), String(row.ends_on), format);
        const reportRunId = await mintCloseReportRun(
          orgId, def, params,
          { packageId: data.packageId, runId: runId ?? null },
          principal,
        );
        try {
          const bytes = await renderReport(orgId, def.id, { ...params, runId: reportRunId });
          rendered.push({ name: def.name, bytes });
          await db.execute(sql`
            update report_runs set status = 'succeeded', finished_at = now(), updated_at = now()
             where id = ${reportRunId} and org_id = ${orgId}`);
        } catch (error) {
          failures.push(spec.slug);
          const message = error instanceof Error ? error.message : String(error);
          await db.execute(sql`
            update report_runs set status = 'failed', error = ${message.slice(0, 1000)},
                   finished_at = now(), updated_at = now()
             where id = ${reportRunId} and org_id = ${orgId}`);
          console.error(`[close-delivery] render failed for ${spec.slug}:`, message);
        }
      }
      if (rendered.length === 0) throw new Error(`no reports rendered for package (${failures.join(", ") || "unknown"})`);

      const packageName = String(row.package_name).startsWith("close.")
        ? "Close reporting package"
        : row.package_name;

      // Bundle: one merged PDF when the package asks to combine (PDF only), else
      // one attachment per report.
      const combined = delivery.combine === true && format === "pdf" && rendered.length > 1;
      const files: Array<{ filename: string; content: string; contentType: string }> = combined
        ? [{ filename: `${slugify(String(packageName), "close-package")}-${dateTag}.pdf`, content: (await mergePdfs(rendered.map((item) => item.bytes))).toString("base64"), contentType: "application/pdf" }]
        : rendered.map((item) => ({
            filename: `${slugify(item.name, "report")}-${dateTag}.${format === "xlsx" ? "xlsx" : "pdf"}`,
            content: item.bytes.toString("base64"),
            contentType: format === "xlsx" ? xlsxType : "application/pdf",
          }));
      const countPhrase = `${rendered.length} report${rendered.length === 1 ? "" : "s"}`;
      const subject = `${packageName} — ${row.period_name} (${row.book_name})`;
      const text =
        `The ${packageName} for ${row.period_name} · ${row.book_name} is attached (${countPhrase}).\n\n` +
        `— ${row.org_name} via OpenBooks`;
      const html =
        `<p>The <strong>${escapeHtml(packageName)}</strong> for <strong>${escapeHtml(row.period_name)}</strong> · ${escapeHtml(row.book_name)} is attached (${countPhrase}).</p>` +
        `<p style="color:#666">${escapeHtml(row.org_name)} · OpenBooks</p>`;

      // Durable email identity, derived from the publication content — never
      // from the parent queue job's id. enqueueCloseDelivery deliberately
      // takes no fixed jobId (every publication, including a corrected
      // re-publication after reopen, is its own delivery obligation), so the
      // parent id is a BullMQ auto-increment counter that restarts after a
      // Redis reset and would align new mail with old sent-log rows. The
      // binder hash identifies the published content: a parent retry
      // collapses onto the same delivery, while a corrected re-publication
      // mints a new binder and therefore new mail. Manual "send now" runs
      // have no content revision, so each invocation mints its own key.
      let emailIntentKey: string;
      if (runId) {
        const binder = await db.execute<{ binder_hash: string | null }>(sql`
          select binder_hash from close_runs where id = ${runId} and org_id = ${orgId}
        `);
        const binderHash = binder.rows[0]?.binder_hash;
        emailIntentKey = binderHash
          ? `close-package|${orgId}|${runId}|${binderHash}`
          : newEmailIntentKey(`close-package|${orgId}|${runId}`);
      } else {
        emailIntentKey = newEmailIntentKey(
          `close-package|${orgId}|${data.packageId}|${data.periodId ?? ""}|${data.bookId ?? ""}`,
        );
      }
      // Stage the rendered bundle outside the queue payload: the email
      // worker fetches the bytes at send time instead of Redis holding
      // report contents for days.
      const attachments = await storeEmailAttachments(files);
      const emailData: EnqueueEmailData = {
        orgId,
        to: recipients,
        subject,
        html,
        text,
        attachments,
        meta: { category: "close-package" },
      };
      try {
        await enqueue(emailData, { jobId: emailIntentKey });
      } catch (error) {
        // A Redis/BullMQ add can accept the job and then lose its reply:
        // the job exists while this throw fires, and deleting the staged
        // refs unconditionally would strand the queued worker with missing
        // blobs. The settlement keeps them when the job provably exists
        // (or when the queue cannot be reached to check) and deletes only
        // on provable non-acceptance; on a kept job it reports success and
        // delivery proceeds down the normal recorded path below.
        const settled = await settleStagedAttachmentsAfterEnqueueError({
          attachments,
          data: emailData,
          jobId: emailIntentKey,
          error,
          probeQueuedJob: deps.probeQueuedJob,
        });
        console.warn(
          `[close-delivery] email enqueue for package ${data.packageId} threw after queue acceptance ` +
          `(job ${settled.jobIds.join(", ")}); keeping staged attachments`,
        );
      }

      await db.execute(sql`
        insert into close_events (org_id, run_id, event_type, payload)
        values (${orgId}, ${runId ?? null}, 'package.delivered',
                ${JSON.stringify({ reports: rendered.length, files: files.length, recipients: recipients.length, combined, failures, truncated })}::jsonb)`);

      return { reports: rendered.length, files: files.length, recipients: recipients.length, combined, failures, truncated };
      });
}

/**
 * Consumes the `close-delivery` queue: render each report attached to a
 * published run's reporting package (with the package author's saved override
 * params) and email the bundle to the recipients via the email queue. A failed
 * single report is skipped and recorded, not fatal; a total render failure
 * throws so BullMQ retries.
 */
export function createCloseDeliveryWorker(): Worker<CloseDeliveryJobData> {
  return new Worker<CloseDeliveryJobData>(
    CLOSE_DELIVERY_QUEUE,
    async (job) => processCloseDeliveryJobData(job.data),
    { connection: getBlockingConnection(), concurrency: 2 },
  );
}
