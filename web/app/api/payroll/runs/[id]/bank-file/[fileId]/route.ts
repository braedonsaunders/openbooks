import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { releasePayRunBankFile } from '@openbooks/engine/src/payroll-bank-file-artifact.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../../lib/list-params'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Release one artifact's bytes.
 *
 * POST rather than GET, deliberately. This is not a document view: handing the
 * characters over is a recorded, counted event on an instruction that moves
 * money, and a link preview, a browser prefetch or a bookmarked URL must not
 * be able to fire it. It is the same reasoning that makes the cheque-print
 * endpoint a POST — that one consumes stock, this one consumes the assurance
 * that the file is still inside the building.
 *
 * `payroll.run`, never `payroll.read`: nobody who could not have run this
 * payroll may read the credit instructions it produced. The bytes live in a
 * private File Cabinet system folder owned by nobody precisely so that the
 * cabinet's own routes cannot reach them either.
 *
 * The engine re-verifies the stored sha256 against the retrieved bytes and
 * writes the audit record before this handler ever sees them; a release that
 * cannot be recorded does not happen.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id, fileId } = await params
  if (!isUuid(id) || !isUuid(fileId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  // The artifact must belong to the run in the URL: an id alone must not be a
  // capability to read any org's payroll file through any run's path.
  const owned = (await db.execute(sql`
    select 1 from pay_run_bank_files
     where org_id = ${gate.user.orgId} and id = ${fileId} and pay_run_document_id = ${id}
  `))
  if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const released = await releasePayRunBankFile(gate.user.orgId, fileId, gate.user.id)
    return new NextResponse(new Uint8Array(released.bytes), {
      headers: {
        'Content-Type': released.contentType,
        'Content-Disposition': `attachment; filename="${released.filename}"`,
        'Content-Length': String(released.bytes.length),
        // Never cached, never stored by an intermediary: these are live
        // payment instructions, and the release count must stay truthful.
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'X-Payroll-Bank-File-Sha256': released.artifact.contentHash,
        'X-Payroll-Bank-File-Number': released.artifact.fileNumber,
        'X-Payroll-Bank-File-Release': String(released.artifact.releaseCount),
      },
    })
  } catch (error) {
    if (error instanceof PayrollError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    throw error
  }
}
