import 'server-only'
import { sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import {
  encryptPdf,
  renderPasswordExpression,
  type PasswordTokenCatalog,
} from '@openbooks/pdf'
import { db } from '@openbooks/engine/src/db.ts'
import { issuePayRunCheques } from '@openbooks/engine/src/payroll-cheques.ts'
import { mergeAndPrintPdf } from './pdf-templates/render'
import { resolvePdfTemplate } from './pdf-templates/store'
import { loadPdfRecordValues } from './pdf-templates/values'
import { sendRecordPdfEmail } from './pdf-templates/send'

/**
 * End-of-run outputs: every stub as one printable PDF, and per-employee stub
 * emails — both riding the org-authored pay_stub template so what prints and
 * what lands in inboxes is exactly what the designer shows.
 *
 * Delivery is per employee (employee_payroll_profiles.stub_delivery): 'email'
 * employees are emailed, 'print' employees are in the print set, 'both' are in
 * each. Emailed stubs are encrypted when the org configures a stub password
 * policy — the password is derived per employee from a configurable token
 * expression, used once, and never logged or stored (the employer publishes
 * the rule to staff out of band).
 */

/** The record values a stub password expression may be written against. */
export const STUB_PASSWORD_TOKENS: PasswordTokenCatalog = {
  surname: 'text',
  givenName: 'text',
  employeeNumber: 'text',
  dob: 'date',
}

/** orgs.settings.payroll.stubPassword. */
export interface StubPasswordPolicy {
  enabled: boolean
  expression: string
}

interface RunStub {
  id: string
  name: string
  email: string | null
  delivery: 'email' | 'print' | 'both'
  surname: string | null
  givenName: string | null
  employeeNumber: string | null
  birthDate: string | null
}

async function runStubs(orgId: string, documentId: string): Promise<RunStub[]> {
  const r = (await db.execute(sql`
    select s.id, p.display_name as name, p.email,
           coalesce(prof.stub_delivery, 'email') as delivery,
           er.employee_number, er.birth_date::text as birth_date
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
     order by p.display_name
  `)) as unknown as {
    rows: {
      id: string; name: string; email: string | null; delivery: string
      employee_number: string | null; birth_date: string | null
    }[]
  }
  return r.rows.map((row) => {
    const [surname, ...given] = splitName(row.name)
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      delivery: (row.delivery === 'print' || row.delivery === 'both' ? row.delivery : 'email'),
      surname: surname ?? null,
      givenName: given.join(' ') || (surname ?? null),
      employeeNumber: row.employee_number,
      birthDate: row.birth_date,
    }
  })
}

/** "First Last" → [surname, ...given]; single token = both. */
function splitName(displayName: string): string[] {
  const clean = displayName.replace(/\s*\(.*\)\s*$/, '').trim()
  const parts = clean.split(/\s+/)
  if (parts.length === 1) return [parts[0]!]
  return [parts[parts.length - 1]!, ...parts.slice(0, -1)]
}

export async function stubPasswordPolicy(orgId: string): Promise<StubPasswordPolicy> {
  const r = (await db.execute(sql`
    select settings#>'{payroll,stubPassword}' as policy from orgs where id = ${orgId}
  `)) as unknown as { rows: { policy: { enabled?: unknown; expression?: unknown } | null }[] }
  const policy = r.rows[0]?.policy ?? {}
  return {
    enabled: policy.enabled === true,
    expression: typeof policy.expression === 'string' ? policy.expression : '',
  }
}

/**
 * The stub's open password under the org policy.
 *
 * SECURITY: the return value is a live credential — hand it straight to the
 * encryptor. It is never logged, never persisted, and never returned to a
 * client; employees learn the rule from their employer, not from us.
 */
function stubPassword(policy: StubPasswordPolicy, stub: RunStub): string {
  return renderPasswordExpression(policy.expression, STUB_PASSWORD_TOKENS, {
    surname: stub.surname,
    givenName: stub.givenName,
    employeeNumber: stub.employeeNumber,
    dob: stub.birthDate,
  })
}

/**
 * One PDF containing the run's stubs in employee order.
 *
 * `set: 'print'` produces the PRINT SET — only the employees whose delivery is
 * 'print' or 'both' — which is what a payroll clerk actually feeds the printer
 * once the emailed stubs have gone out. 'all' keeps the whole-run copy used
 * for the run's own records.
 */
export async function mergedRunStubsPdf(
  orgId: string,
  documentId: string,
  options: { set?: 'all' | 'print' } = {},
): Promise<{ pdf: Uint8Array; count: number } | null> {
  const all = await runStubs(orgId, documentId)
  const stubs = options.set === 'print'
    ? all.filter((stub) => stub.delivery === 'print' || stub.delivery === 'both')
    : all
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

/**
 * The run's cheque batch as one printable PDF, in the order the numbers were
 * allocated — the stack a clerk feeds the printer.
 *
 * This is `mergedRunStubsPdf` with a different record type: same template
 * resolution, same value loader, same pdf-lib merge. Cheque numbers are
 * allocated by the engine first (idempotent), so reprinting a batch reprints
 * the same numbers instead of consuming stock.
 */
export async function mergedRunChequesPdf(
  orgId: string,
  documentId: string,
  actorId: string,
): Promise<{ pdf: Uint8Array; count: number; issued: number } | null> {
  const batch = await issuePayRunCheques({ orgId, documentId, actorId })
  if (batch.cheques.length === 0) return null
  const template = await resolvePdfTemplate(orgId, 'payroll_cheque', null)
  if (!template) return null

  const merged = await PDFDocument.create()
  let count = 0
  for (const cheque of batch.cheques) {
    const record = await loadPdfRecordValues('payroll_cheque', orgId, cheque.stubId)
    if (!record) continue
    const pdf = await mergeAndPrintPdf(template, record.values)
    const doc = await PDFDocument.load(pdf)
    const pages = await merged.copyPages(doc, doc.getPageIndices())
    for (const page of pages) merged.addPage(page)
    count += 1
  }
  return { pdf: await merged.save(), count, issued: batch.issued }
}

export interface EmailStubsResult {
  sent: number
  noEmail: string[]
  /** Employees whose delivery preference is print-only. */
  printOnly: string[]
  failed: { name: string; error: string }[]
}

/**
 * Email each employee their own stub PDF, honouring the delivery preference;
 * never partial-fails the batch. When a stub password policy is configured the
 * attachment is encrypted per employee, and an employee whose password cannot
 * be derived FAILS rather than receiving an unprotected stub.
 */
export async function emailRunStubs(orgId: string, documentId: string): Promise<EmailStubsResult> {
  const stubs = await runStubs(orgId, documentId)
  const policy = await stubPasswordPolicy(orgId)
  const result: EmailStubsResult = { sent: 0, noEmail: [], printOnly: [], failed: [] }
  for (const stub of stubs) {
    if (stub.delivery === 'print') {
      result.printOnly.push(stub.name)
      continue
    }
    if (!stub.email?.trim()) {
      result.noEmail.push(stub.name)
      continue
    }
    try {
      await sendRecordPdfEmail({
        recordType: 'pay_stub',
        orgId,
        id: stub.id,
        // Encryption fails closed: a policy that cannot produce this
        // employee's password stops their email, it never downgrades it.
        ...(policy.enabled
          ? { encrypt: async (pdf: Buffer) => encryptPdf(pdf, { userPassword: stubPassword(policy, stub) }) }
          : {}),
      })
      result.sent += 1
    } catch (e) {
      result.failed.push({ name: stub.name, error: (e as Error).message })
    }
  }
  return result
}
