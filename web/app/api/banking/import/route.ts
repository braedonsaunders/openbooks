import { NextResponse } from 'next/server'
import {
  BankingError,
  importStatement,
  parseBai2,
  parseCamt053,
  parseCsv,
  parseCsvRows,
  parseMt940,
  parseOfx,
  type CsvMapping,
  type ParsedStatement,
  type ParsedStatementLine,
} from '@openbooks/engine/src/banking.ts'
import { guardPermission } from '../../../../lib/authz'
import { bankingErrorResponse } from '../util'

export const runtime = 'nodejs'

interface ImportBody {
  accountId?: string
  source?: 'ofx' | 'csv' | 'camt053' | 'bai2' | 'mt940'
  text?: string
  mapping?: CsvMapping
  /**
   * columns — CSV only: return header + sample rows so the client can build
   *           the column-mapping selects (single parser lives in the engine).
   * preview — parse + dedupe, write nothing.
   * import  — parse + dedupe + persist.
   */
  mode?: 'columns' | 'preview' | 'import'
  statementDate?: string | null
  openingBalance?: string | null
  closingBalance?: string | null
}

export async function POST(req: Request) {
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json()) as ImportBody
  const mode = body.mode ?? 'preview'

  if (!body.text?.trim()) {
    return NextResponse.json({ error: 'Paste or upload statement text first' }, { status: 400 })
  }

  try {
    if (mode === 'columns') {
      if (body.source !== 'csv') {
        return NextResponse.json({ error: 'Column detection applies to CSV only' }, { status: 400 })
      }
      const rows = parseCsvRows(body.text)
      return NextResponse.json({
        header: rows[0],
        sample: rows.slice(1, 6),
        rowCount: rows.length,
      })
    }

    if (!body.accountId) {
      return NextResponse.json({ error: 'accountId required' }, { status: 400 })
    }

    let lines: ParsedStatementLine[]
    let meta: Omit<ParsedStatement, 'lines'> = {}
    if (body.source === 'ofx') {
      const parsed = parseOfx(body.text)
      lines = parsed.lines
      meta = { currency: parsed.currency, statementDate: parsed.statementDate, closingBalance: parsed.closingBalance }
    } else if (body.source === 'csv') {
      if (!body.mapping || body.mapping.date == null || body.mapping.amount == null || body.mapping.description == null) {
        return NextResponse.json({ error: 'CSV column mapping (date, amount, description) required' }, { status: 400 })
      }
      lines = parseCsv(body.text, body.mapping)
    } else if (body.source === 'camt053' || body.source === 'bai2' || body.source === 'mt940') {
      const parsed =
        body.source === 'camt053' ? parseCamt053(body.text)
        : body.source === 'bai2' ? parseBai2(body.text)
        : parseMt940(body.text)
      lines = parsed.lines
      meta = { currency: parsed.currency, statementDate: parsed.statementDate, closingBalance: parsed.closingBalance }
    } else {
      return NextResponse.json({ error: 'source must be ofx, csv, camt053, bai2 or mt940' }, { status: 400 })
    }

    const result = await importStatement(
      {
        accountId: body.accountId,
        source: body.source,
        lines,
        statementDate: body.statementDate ?? meta.statementDate ?? null,
        openingBalance: body.openingBalance ?? null,
        closingBalance: body.closingBalance ?? meta.closingBalance ?? null,
        currency: meta.currency ?? null,
        dryRun: mode === 'preview',
      },
      { orgId: user.orgId, userId: user.id },
    )

    if (mode === 'import' && result.statementId === null) {
      throw new BankingError(
        `Nothing imported — all ${result.duplicates} line${result.duplicates === 1 ? '' : 's'} were already on this account`,
      )
    }

    return NextResponse.json({
      statementId: result.statementId,
      imported: result.imported,
      duplicates: result.duplicates,
      statementDate: meta.statementDate ?? null,
      closingBalance: meta.closingBalance ?? null,
      currency: meta.currency ?? null,
      lines: mode === 'preview' ? result.lines : undefined,
    })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
