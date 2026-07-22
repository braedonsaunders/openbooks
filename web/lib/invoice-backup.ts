import 'server-only'
import { PDFDocument } from 'pdf-lib'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { renderHtmlDocumentPdf } from '@openbooks/pdf'
import { getS3Blob } from './file-storage'
import { listAttachments, uploadAndAttach } from './file-cabinet'
import { resolvePdfTemplate } from './pdf-templates/store'
import { loadPdfRecordValues } from './pdf-templates/values'
import { mergeAndPrintPdf } from './pdf-templates/render'

/**
 * Invoice backup PDF package — the native reimplementation of adminapp2's
 * getInvoiceBackupPDF (a source platform front-end there). Assembles, in a configurable
 * order, the invoice PDF + a costed-timesheet page + the vendor-bill/receipt
 * attachments of the cost documents the invoice billed, merges them with pdf-lib,
 * and stores the package in the file cabinet attached to the invoice document.
 *
 * The backup-type matrix is data (BACKUP_RECIPES), not branchy code, so an org
 * can remap which components a backup type includes.
 */

export type BackupType =
  | 'none'
  | 'costed_timesheets'
  | 'quote_only'
  | 'timesheets_purchases'
  | 'purchases'
  | 'purchases_shop_time'

type ComponentKind = 'invoice' | 'costed_timesheets' | 'shop_time' | 'attachments' | 'field_tickets'

/** Ordered components per backup type — the configurable matrix. */
const BACKUP_RECIPES: Record<BackupType, ComponentKind[]> = {
  none: ['invoice'],
  costed_timesheets: ['invoice', 'field_tickets', 'costed_timesheets'],
  quote_only: ['invoice'],
  timesheets_purchases: ['invoice', 'field_tickets', 'costed_timesheets', 'attachments'],
  purchases: ['invoice', 'attachments'],
  purchases_shop_time: ['invoice', 'attachments', 'shop_time'],
}

export interface BackupManifestEntry {
  kind: ComponentKind
  sourceDocumentId?: string
  sourceFileId?: string
  pages: number
}

export interface AssembleResult {
  fileId: string
  pageCount: number
  manifest: BackupManifestEntry[]
}

const money = (v: unknown) => `$${Number(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))

/** Read a stored file's bytes (db blob or S3), by file id. */
async function readFileBytes(orgId: string, fileId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const r = (await db.execute(sql`
    select fi.content_type, fi.current_version_id as version_id, fb.bytes
      from files fi
      left join file_blobs fb on fb.version_id = fi.current_version_id
     where fi.id = ${fileId} and fi.org_id = ${orgId}
  `)) as unknown as { rows: { content_type: string; version_id: string | null; bytes: Buffer | null }[] }
  const row = r.rows[0]
  if (!row) return null
  if (row.bytes) return { bytes: Buffer.from(row.bytes), contentType: row.content_type }
  if (row.version_id) {
    const s3 = await getS3Blob(row.version_id)
    if (s3) return { bytes: s3, contentType: row.content_type }
  }
  return null
}

/** Merge a source PDF buffer into the master document, returning page count. */
async function mergePdfInto(out: PDFDocument, buf: Buffer): Promise<number> {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true })
  const pages = await out.copyPages(src, src.getPageIndices())
  pages.forEach((p) => out.addPage(p))
  return pages.length
}

/** Draw an image (jpg/png) as one full letter page. */
async function addImagePage(out: PDFDocument, bytes: Buffer, contentType: string): Promise<boolean> {
  try {
    const img = contentType.includes('png') ? await out.embedPng(bytes) : await out.embedJpg(bytes)
    const page = out.addPage([612, 792]) // US Letter, points
    const scaled = img.scaleToFit(540, 720)
    page.drawImage(img, { x: (612 - scaled.width) / 2, y: (792 - scaled.height) / 2, width: scaled.width, height: scaled.height })
    return true
  } catch {
    return false
  }
}

/** Render the costed-timesheet page (billed time with cost + bill columns). */
async function costedTimesheetPdf(orgId: string, documentId: string, invoiceNumber: string, projectName: string, title: string): Promise<Buffer | null> {
  const rows = (await db.execute(sql`
    select te.worked_on, coalesce(pty.display_name, '') as employee, te.hours,
           te.cost_rate, te.bill_rate,
           te.hours * coalesce(te.cost_rate, 0) as cost_amount,
           dl.amount as bill_amount, coalesce(i.name, '') as item
      from time_entries te
      join document_lines dl on dl.id = te.invoiced_by_line_id
      left join parties pty on pty.id = te.employee_party_id
      left join items i on i.id = te.item_id
     where dl.document_id = ${documentId} and te.org_id = ${orgId}
     order by te.worked_on, employee
  `)) as unknown as { rows: any[] }
  if (rows.rows.length === 0) return null

  const totals = rows.rows.reduce(
    (a, r) => ({ hours: a.hours + Number(r.hours ?? 0), cost: a.cost + Number(r.cost_amount ?? 0), bill: a.bill + Number(r.bill_amount ?? 0) }),
    { hours: 0, cost: 0, bill: 0 },
  )
  const body = rows.rows
    .map(
      (r) => `<tr>
      <td>${esc(r.worked_on)}</td><td>${esc(r.employee)}</td><td>${esc(r.item)}</td>
      <td class="n">${Number(r.hours ?? 0).toFixed(2)}</td>
      <td class="n">${money(r.cost_rate)}</td><td class="n">${money(r.cost_amount)}</td>
      <td class="n">${money(r.bill_rate)}</td><td class="n">${money(r.bill_amount)}</td></tr>`,
    )
    .join('')
  const html = `
    <style>
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color:#111; }
      h1 { font-size: 15px; margin: 0 0 2px; }
      .sub { color:#555; font-size: 11px; margin-bottom: 10px; }
      table { width:100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align:left; }
      th { background:#f3f4f6; font-size:10px; text-transform:uppercase; letter-spacing:.03em; }
      td.n, th.n { text-align:right; font-variant-numeric: tabular-nums; }
      tfoot td { font-weight:700; border-top:2px solid #333; }
    </style>
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(projectName)} &middot; Invoice ${esc(invoiceNumber)}</div>
    <table>
      <thead><tr><th>Date</th><th>Employee</th><th>Service</th><th class="n">Hours</th>
        <th class="n">Cost rate</th><th class="n">Cost</th><th class="n">Bill rate</th><th class="n">Amount</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="3">Total</td><td class="n">${totals.hours.toFixed(2)}</td><td></td>
        <td class="n">${money(totals.cost)}</td><td></td><td class="n">${money(totals.bill)}</td></tr></tfoot>
    </table>`
  return renderHtmlDocumentPdf({ bodyHtml: html, paperSize: 'letter', orientation: 'landscape', marginMm: 12, headerHtml: null, footerHtml: null })
}

/**
 * Assemble + persist the backup package for a posted/draft invoice document.
 * NOT wrapped in an outer db.transaction — uploadAndAttach/createFile run their
 * own tx on the shared pool. Returns the stored file id + manifest.
 */
export async function assembleInvoiceBackup(
  orgId: string,
  userId: string,
  documentId: string,
  backupType: BackupType = 'costed_timesheets',
): Promise<AssembleResult> {
  const invRes = (await db.execute(sql`
    select d.document_number, coalesce(p.name, '') as project_name
      from documents d left join projects p on p.id = d.project_id
     where d.id = ${documentId} and d.org_id = ${orgId} and d.kind = 'customer_invoice'
  `)) as unknown as { rows: { document_number: string; project_name: string }[] }
  const inv = invRes.rows[0]
  if (!inv) throw new Error('Invoice not found')

  const recipe = BACKUP_RECIPES[backupType] ?? BACKUP_RECIPES.costed_timesheets
  const out = await PDFDocument.create()
  const manifest: BackupManifestEntry[] = []

  for (const kind of recipe) {
    if (kind === 'invoice') {
      const tpl = await resolvePdfTemplate(orgId, 'customer_invoice', null)
      const record = await loadPdfRecordValues('customer_invoice', orgId, documentId)
      if (tpl && record) {
        const buf = await mergeAndPrintPdf(tpl, record.values)
        const pages = await mergePdfInto(out, buf)
        manifest.push({ kind, pages })
      }
    } else if (kind === 'costed_timesheets' || kind === 'shop_time') {
      const title = kind === 'shop_time' ? 'Shop Labour Backup' : 'Costed Timesheet'
      const buf = await costedTimesheetPdf(orgId, documentId, inv.document_number, inv.project_name, title)
      if (buf) {
        const pages = await mergePdfInto(out, buf)
        manifest.push({ kind, pages })
      }
    } else if (kind === 'field_tickets') {
      // Signed field tickets whose hours this invoice billed — the T&M
      // substantiation packet. Each distinct ticket renders once via the org's
      // ticket template (signature included when present).
      const tickets = (await db.execute(sql`
        select distinct te.field_ticket_id
          from document_lines inv_line
          join time_entries te on te.invoiced_by_line_id = inv_line.id
         where inv_line.document_id = ${documentId} and inv_line.org_id = ${orgId}
           and te.field_ticket_id is not null
      `)) as unknown as { rows: { field_ticket_id: string }[] }
      if (tickets.rows.length > 0) {
        const tpl = await resolvePdfTemplate(orgId, 'field_ticket', null)
        if (tpl) {
          for (const tk of tickets.rows) {
            const record = await loadPdfRecordValues('field_ticket', orgId, tk.field_ticket_id)
            if (!record) continue
            const buf = await mergeAndPrintPdf(tpl, record.values)
            const pages = await mergePdfInto(out, buf)
            if (pages > 0) manifest.push({ kind, sourceDocumentId: tk.field_ticket_id, pages })
          }
        }
      }
    } else if (kind === 'attachments') {
      // Source cost documents this invoice billed → their attachments.
      const sources = (await db.execute(sql`
        select distinct src.document_id
          from document_lines inv_line
          join document_lines src on src.billed_by_line_id = inv_line.id
         where inv_line.document_id = ${documentId} and inv_line.org_id = ${orgId}
      `)) as unknown as { rows: { document_id: string }[] }
      for (const s of sources.rows) {
        const atts = await listAttachments(orgId, 'documents', s.document_id)
        for (const att of atts) {
          const file = await readFileBytes(orgId, att.id)
          if (!file) continue
          let pages = 0
          if (file.contentType === 'application/pdf') {
            pages = await mergePdfInto(out, file.bytes)
          } else if (file.contentType.startsWith('image/')) {
            pages = (await addImagePage(out, file.bytes, file.contentType)) ? 1 : 0
          }
          if (pages > 0) manifest.push({ kind, sourceDocumentId: s.document_id, sourceFileId: att.id, pages })
        }
      }
    }
  }

  const pdfBytes = Buffer.from(await out.save())
  const pageCount = out.getPageCount()

  // Replace any prior backup file for this invoice, then store + record.
  const prior = (await db.execute(sql`
    select file_id from invoice_backups where org_id = ${orgId} and document_id = ${documentId}
  `)) as unknown as { rows: { file_id: string }[] }
  const stored = await uploadAndAttach({
    orgId,
    targetTable: 'documents',
    targetId: documentId,
    filename: `${inv.document_number} Backup.pdf`,
    contentType: 'application/pdf',
    bytes: pdfBytes,
    createdBy: userId,
  })
  await db.execute(sql`
    insert into invoice_backups (org_id, document_id, backup_type, file_id, page_count, component_manifest, created_by, updated_by)
    values (${orgId}, ${documentId}, ${backupType}, ${stored.id}, ${pageCount}, ${JSON.stringify(manifest)}::jsonb, ${userId}, ${userId})
    on conflict (org_id, document_id) do update
      set backup_type = excluded.backup_type, file_id = excluded.file_id, page_count = excluded.page_count,
          component_manifest = excluded.component_manifest, generated_at = now(), updated_by = ${userId}
  `)
  if (prior.rows[0]?.file_id && prior.rows[0].file_id !== stored.id) {
    await db.execute(sql`delete from file_attachments where org_id = ${orgId} and file_id = ${prior.rows[0].file_id}`)
    await db.execute(sql`delete from file_blobs where version_id in (select current_version_id from files where id = ${prior.rows[0].file_id})`)
    await db.execute(sql`delete from files where id = ${prior.rows[0].file_id} and org_id = ${orgId}`)
  }

  return { fileId: stored.id, pageCount, manifest }
}

/** The stored backup (file id + bytes) for an invoice, if assembled. */
export async function loadInvoiceBackup(orgId: string, documentId: string): Promise<{ fileId: string; filename: string; bytes: Buffer } | null> {
  const r = (await db.execute(sql`
    select ib.file_id, fi.name from invoice_backups ib join files fi on fi.id = ib.file_id
     where ib.org_id = ${orgId} and ib.document_id = ${documentId}
  `)) as unknown as { rows: { file_id: string; name: string }[] }
  const row = r.rows[0]
  if (!row) return null
  const file = await readFileBytes(orgId, row.file_id)
  if (!file) return null
  return { fileId: row.file_id, filename: row.name, bytes: file.bytes }
}
