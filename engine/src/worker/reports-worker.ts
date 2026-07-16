import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { REPORTS_QUEUE, enqueueEmail, getBlockingConnection, type ReportJobData } from "@openbooks/jobs";
import { scheduledReportEmail } from "@openbooks/emails";
import { db } from "../db.ts";
import { renderReportPdf } from "./render-client.ts";

/**
 * Consumes the `reports` queue: render one definition to a PDF and fan it out to
 * the schedule's recipients via the email queue. Records a report_runs row for
 * the audit trail; on render failure the run is marked failed and BullMQ retries.
 */
export function createReportsWorker(): Worker<ReportJobData> {
  return new Worker<ReportJobData>(
    REPORTS_QUEUE,
    async (job) => {
      const d = job.data;
      const meta = (await db.execute(sql`
        select rd.name as report_name, o.name as org_name
          from report_definitions rd join orgs o on o.id = rd.org_id
         where rd.id = ${d.definitionId} and rd.org_id = ${d.orgId}
      `)) as unknown as { rows: { report_name: string; org_name: string }[] };
      const reportName = meta.rows[0]?.report_name ?? "Report";
      const orgName = meta.rows[0]?.org_name ?? "OpenBooks";

      const run = (await db.execute(sql`
        insert into report_runs (org_id, schedule_id, definition_id, trigger, status, started_at)
        values (${d.orgId}, ${d.scheduleId ?? null}, ${d.definitionId}, 'scheduled', 'running', now())
        returning id
      `)) as unknown as { rows: { id: string }[] };
      const runId = run.rows[0]!.id;

      try {
        const pdf = await renderReportPdf(d.orgId, d.definitionId, d.params ?? {});
        const slug = reportName.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
        const attachmentName = `${slug || "report"}-${new Date().toISOString().slice(0, 10)}.pdf`;
        const mail = scheduledReportEmail({ orgName, reportName, attachmentName });

        await enqueueEmail(
          {
            orgId: d.orgId,
            to: d.recipients,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            attachments: [{ filename: attachmentName, content: pdf.toString("base64"), contentType: "application/pdf" }],
            meta: { category: "report", reportRunId: runId },
          },
          { jobId: `report-run|${runId}` },
        );

        await db.execute(sql`update report_runs set status = 'succeeded', finished_at = now() where id = ${runId}`);
        return { runId, recipients: d.recipients.length };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await db.execute(sql`update report_runs set status = 'failed', error = ${msg.slice(0, 500)}, finished_at = now() where id = ${runId}`);
        throw e;
      }
    },
    { connection: getBlockingConnection(), concurrency: 3 },
  );
}
