import 'server-only'
import { sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { ensureReportDefinitions } from '@openbooks/engine/src/ensure-report-definitions.ts'
import { PayrollError, previewPayRunGl } from '@openbooks/engine/src/payroll-run.ts'
import { resolveDefinitionToExportData } from './report-run'
import { exportDataToPdf, orgBranding, resolveLayout, type ExportData, type Translator } from './report-pdf'
import { parseReportQuery } from './report-filters'
import { resolvePeriod } from './periods'
import { uploadAndAttach } from './file-cabinet'

/**
 * The pay-run approval evidence package.
 *
 * An approver must not be asked to approve a number with no working papers, so
 * submitting a run for approval assembles the same three artifacts a payroll
 * reviewer asks for and attaches them to the run itself:
 *
 *   1. the payroll journal   (report definition `payroll-journal`),
 *   2. the payroll register  (report definition `payroll-register`),
 *   3. the run's GL preview  (previewPayRunGl — the exact legs commit writes).
 *
 * Both reports come from the report engine through the SAME resolver the
 * Reports hub, exports, and the scheduler use, filtered to this run's number —
 * there is no second payroll reporting path, and what an approver reads is
 * byte-for-byte what the hub shows. The three PDFs are merged with pdf-lib
 * (the merge the run's stub packet already uses) and attached through the File
 * Cabinet, so the approvals worklist link, the run record, and the audit trail
 * all show the same immutable evidence.
 */

const EVIDENCE_SLUGS = ['payroll-journal', 'payroll-register'] as const

export interface PayRunEvidence {
  fileId: string
  filename: string
  /** What made it into the package, for the audit note and the UI. */
  parts: string[]
}

interface RunHeader {
  document_number: string
  period_start: string
  period_end: string
  pay_date: string
  run_status: string
}

async function loadRun(orgId: string, documentId: string): Promise<RunHeader> {
  const r = (await db.execute(sql`
    select d.document_number, r.period_start::text as period_start,
           r.period_end::text as period_end, r.pay_date::text as pay_date, r.run_status
      from pay_runs r
      join documents d on d.id = r.document_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `)) as unknown as { rows: RunHeader[] }
  const run = r.rows[0]
  if (!run) throw new PayrollError('pay run not found')
  return run
}

/** The GL preview as report-engine content, so it prints like the other two. */
async function glPreviewExportData(
  orgId: string,
  documentId: string,
  run: RunHeader,
  title: string,
): Promise<ExportData> {
  const preview = await previewPayRunGl(orgId, documentId)
  return {
    title,
    dateRangeLabel: `${run.period_start} – ${run.period_end}`,
    summary: [{ label: 'Total debits', value: preview.debitTotal }],
    groups: [{
      kind: 'results',
      title,
      columns: ['Account', 'Party', 'Project', 'Amount'],
      align: ['left', 'left', 'left', 'right'],
      rows: preview.legs.map((leg) => [
        leg.accountLabel,
        leg.partyName ?? '',
        leg.projectName ?? '',
        leg.amount,
      ]),
    }],
  } as ExportData
}

/**
 * Build the package and attach it to the pay-run document. Returns the stored
 * file so the caller can record it on the approval request.
 */
export async function assemblePayRunEvidence(
  orgId: string,
  userId: string,
  documentId: string,
): Promise<PayRunEvidence> {
  const run = await loadRun(orgId, documentId)
  if (run.run_status === 'draft') {
    throw new PayrollError('calculate the pay run before submitting it for approval')
  }
  await ensureReportDefinitions(orgId)

  const t = (await getTranslations('reports')) as unknown as Translator
  const period = await resolvePeriod('custom', {
    customFrom: run.period_start, customTo: run.pay_date, orgId,
  })
  const params = new URLSearchParams({ period: 'custom', from: run.period_start, to: run.pay_date })
  const ctx = { orgId, t, period, query: parseReportQuery(params) }
  const branding = await orgBranding(orgId)
  const { page, showSummary } = resolveLayout(null)

  const definitions = (await db.execute(sql`
    select slug, id, name from report_definitions
     where org_id = ${orgId} and slug = any(${`{${EVIDENCE_SLUGS.join(',')}}`}::text[])
  `)) as unknown as { rows: { slug: string; id: string; name: string }[] }

  const parts: string[] = []
  const pdfs: Buffer[] = []
  for (const slug of EVIDENCE_SLUGS) {
    const definition = definitions.rows.find((row) => row.slug === slug)
    if (!definition) continue
    const data = await resolveDefinitionToExportData(orgId, definition.id, params, ctx, {
      // The exact run, not merely its period: an off-cycle run inside a period
      // already paid must not drag the regular run's numbers into evidence.
      extraFilters: {
        combinator: 'and',
        rules: [{ field: 'run_number', op: 'eq', value: run.document_number }],
      },
    })
    pdfs.push(await exportDataToPdf(data, branding, page, { showSummary }))
    parts.push(definition.name)
  }

  const glTitle = `GL preview ${run.document_number}`
  pdfs.push(await exportDataToPdf(
    await glPreviewExportData(orgId, documentId, run, glTitle), branding, page, { showSummary: true },
  ))
  parts.push(glTitle)

  const merged = await PDFDocument.create()
  for (const pdf of pdfs) {
    const doc = await PDFDocument.load(pdf)
    const pages = await merged.copyPages(doc, doc.getPageIndices())
    for (const copied of pages) merged.addPage(copied)
  }
  const filename = `${run.document_number}-payroll-evidence.pdf`.replace(/\s+/g, '-')
  const stored = await uploadAndAttach({
    orgId,
    targetTable: 'documents',
    targetId: documentId,
    filename,
    contentType: 'application/pdf',
    bytes: Buffer.from(await merged.save()),
    createdBy: userId,
  })
  return { fileId: stored.id, filename, parts }
}
