import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import {
  CLOSE_DELIVERY_QUEUE,
  enqueueEmail,
  getBlockingConnection,
  type CloseDeliveryJobData,
} from "@openbooks/jobs";
import { db } from "../db.ts";
import { ensureReportDefinitions } from "../ensure-report-definitions.ts";
import { renderReportPdf } from "./render-client.ts";

/** Per-report override captured on the package (mirrors the UI's
 * ReportAttachment). Legacy packages stored bare slug strings. */
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
    .map((item) => (typeof item === "string" ? { slug: item } : item))
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
  org_name: string;
};

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
           pkg.name as package_name, pkg.reports, pkg.recipients, pkg.delivery, o.name as org_name`;
  const rows = runId
    ? ((await db.execute(sql`
        select ${select}
          from close_runs r
          join accounting_periods p on p.id = r.period_id
          join accounting_books b on b.id = r.book_id
          join close_reporting_packages pkg on pkg.id = ${packageId} and pkg.org_id = ${orgId}
          join orgs o on o.id = r.org_id
         where r.id = ${runId} and r.org_id = ${orgId}`)) as unknown as { rows: PackageContext[] }).rows
    : ((await db.execute(sql`
        select ${select}
          from accounting_periods p
          join accounting_books b on b.id = ${bookId} and b.org_id = ${orgId}
          join close_reporting_packages pkg on pkg.id = ${packageId} and pkg.org_id = ${orgId}
          join orgs o on o.id = ${orgId}
         where p.id = ${periodId} and p.org_id = ${orgId}`)) as unknown as { rows: PackageContext[] }).rows;
  return rows[0];
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
    async (job) => {
      const { orgId, runId, packageId } = job.data;
      const row = await loadContext(job.data);
      if (!row) throw new Error("close run / period or reporting package not found");

      const delivery = (row.delivery ?? {}) as Record<string, unknown>;
      if (delivery.cadence === "manual") return { skipped: "manual cadence" };

      const recipients = (Array.isArray(row.recipients) ? row.recipients : []).filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (recipients.length === 0) return { skipped: "no recipients" };

      const attachmentsSpec = normalizeAttachments(row.reports);
      if (attachmentsSpec.length === 0) return { skipped: "no reports" };
      const truncated = attachmentsSpec.length > MAX_REPORTS;
      const specs = attachmentsSpec.slice(0, MAX_REPORTS);

      // Guarantee every catalog slug (statements + built-ins) resolves to an id.
      await ensureReportDefinitions(orgId);
      const defs = (await db.execute(sql`
        select slug, id, name from report_definitions
         where org_id = ${orgId} and slug in (${sql.join(specs.map((spec) => sql`${spec.slug}`), sql`, `)})`)) as unknown as {
        rows: Array<{ slug: string; id: string; name: string }>;
      };
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
        try {
          const bytes = await renderReportPdf(orgId, def.id, renderParams(spec, String(row.starts_on), String(row.ends_on), format));
          rendered.push({ name: def.name, bytes });
        } catch (error) {
          failures.push(spec.slug);
          console.error(`[close-delivery] render failed for ${spec.slug}:`, error instanceof Error ? error.message : error);
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

      await enqueueEmail(
        {
          orgId,
          to: recipients,
          subject,
          html,
          text,
          attachments: files,
          meta: { category: "close-package" },
        },
        { jobId: `close-package|${job.id}` },
      );

      await db.execute(sql`
        insert into close_events (org_id, run_id, event_type, payload)
        values (${orgId}, ${runId ?? null}, 'package.delivered',
                ${JSON.stringify({ reports: rendered.length, files: files.length, recipients: recipients.length, combined, failures, truncated })}::jsonb)`);

      return { reports: rendered.length, files: files.length, recipients: recipients.length, combined, failures, truncated };
    },
    { connection: getBlockingConnection(), concurrency: 2 },
  );
}
