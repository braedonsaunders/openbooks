import 'server-only'
import { sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { db } from '@openbooks/engine/src/db.ts'
import { mergeAndPrintPdf } from './pdf-templates/render'
import { resolvePdfTemplate } from './pdf-templates/store'
import { loadPdfRecordValues } from './pdf-templates/values'
import { sendRecordPdfEmail } from './pdf-templates/send'

/**
 * End-of-run outputs: every stub as one printable PDF, and per-employee stub
 * emails — both riding the org-authored pay_stub template so what prints and
 * what lands in inboxes is exactly what the designer shows.
 */

async function runStubs(orgId: string, documentId: string) {
  const r = (await db.execute(sql`
    select s.id, p.display_name as name, p.email
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
     order by p.display_name
  `)) as unknown as { rows: { id: string; name: string; email: string | null }[] }
  return r.rows
}

/** One PDF containing every stub in the run, in employee order. */
export async function mergedRunStubsPdf(
  orgId: string,
  documentId: string,
): Promise<{ pdf: Uint8Array; count: number } | null> {
  const stubs = await runStubs(orgId, documentId)
  if (stubs.length === 0) return null
  const template = await resolvePdfTemplate(orgId, 'pay_stub', null)
  if (!template) return null

  const merged = await PDFDocument.create()
  for (const stub of stubs) {
    const record = await loadPdfRecordValues('pay_stub', orgId, stub.id)
    if (!record) continue
    const pdf = await mergeAndPrintPdf(template, record.values)
    const doc = await PDFDocument.load(pdf)
    const pages = await merged.copyPages(doc, doc.getPageIndices())
    for (const page of pages) merged.addPage(page)
  }
  return { pdf: await merged.save(), count: stubs.length }
}

export interface EmailStubsResult {
  sent: number
  noEmail: string[]
  failed: { name: string; error: string }[]
}

/** Email each employee their own stub PDF; never partial-fails the batch. */
export async function emailRunStubs(orgId: string, documentId: string): Promise<EmailStubsResult> {
  const stubs = await runStubs(orgId, documentId)
  const result: EmailStubsResult = { sent: 0, noEmail: [], failed: [] }
  for (const stub of stubs) {
    if (!stub.email?.trim()) {
      result.noEmail.push(stub.name)
      continue
    }
    try {
      await sendRecordPdfEmail({ recordType: 'pay_stub', orgId, id: stub.id })
      result.sent += 1
    } catch (e) {
      result.failed.push({ name: stub.name, error: (e as Error).message })
    }
  }
  return result
}
