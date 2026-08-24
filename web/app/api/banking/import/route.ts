import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import {
  BANK_STATEMENT_PARSER_VERSION,
  BankingError,
  decodeStatementSourceText,
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
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { bankingErrorResponse } from '../util'

export const runtime = 'nodejs'

interface ImportBody {
  accountId?: string
  source?: 'ofx' | 'csv' | 'camt053' | 'bai2' | 'mt940'
  text?: string
  /** Exact bytes from a browser file upload. Engine parsers decode these bytes directly. */
  sourceBytesBase64?: string | null
  filename?: string | null
  contentType?: string | null
  mapping?: CsvMapping
  /**
   * decode  — return engine-decoded review text for exact browser-upload bytes.
   * columns — CSV only: return header + sample rows so the client can build
   *           the column-mapping selects (single parser lives in the engine).
   * preview — parse + dedupe, write nothing.
   * import  — parse + dedupe + persist.
   */
  mode?: 'decode' | 'columns' | 'preview' | 'import'
  statementDate?: string | null
  openingBalance?: string | null
  closingBalance?: string | null
}

const CANONICAL_BASE64 = /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/

/** Decode browser-upload evidence without accepting Node's permissive base64 aliases. */
function uploadedSourceBytes(value: unknown): Buffer | null | 'invalid' {
  if (value == null) return null
  if (typeof value !== 'string' || !CANONICAL_BASE64.test(value)) return 'invalid'
  const bytes = Buffer.from(value, 'base64')
  return bytes.toString('base64') === value ? bytes : 'invalid'
}

/** Exact numeric(19,4) money string, null when omitted, or 'invalid'. */
function persistMoney(value: unknown): string | null | 'invalid' {
  if (value == null || value === '') return null
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as ImportBody
  const mode = body.mode ?? 'preview'

  if (mode !== 'decode' && mode !== 'columns' && mode !== 'preview' && mode !== 'import') {
    return NextResponse.json({ error: 'mode must be decode, columns, preview or import' }, { status: 400 })
  }

  const uploadedBytes = uploadedSourceBytes(body.sourceBytesBase64)
  if (uploadedBytes === 'invalid') {
    return NextResponse.json({ error: 'Uploaded statement bytes must be canonical base64' }, { status: 400 })
  }
  const sourceContent = uploadedBytes ?? (typeof body.text === 'string' ? body.text : null)

  if (
    sourceContent === null
    || (typeof sourceContent === 'string' ? !sourceContent.trim() : sourceContent.byteLength === 0)
  ) {
    return NextResponse.json({ error: 'Paste or upload statement text first' }, { status: 400 })
  }

  try {
    if (mode === 'decode') {
      if (
        body.source !== 'ofx'
        && body.source !== 'csv'
        && body.source !== 'camt053'
        && body.source !== 'bai2'
        && body.source !== 'mt940'
      ) {
        return NextResponse.json({ error: 'source must be ofx, csv, camt053, bai2 or mt940' }, { status: 400 })
      }
      return NextResponse.json({ text: decodeStatementSourceText(sourceContent, body.source) })
    }

    if (mode === 'columns') {
      if (body.source !== 'csv') {
        return NextResponse.json({ error: 'Column detection applies to CSV only' }, { status: 400 })
      }
      const rows = parseCsvRows(sourceContent)
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
      const parsed = parseOfx(sourceContent)
      lines = parsed.lines
      meta = { currency: parsed.currency, statementDate: parsed.statementDate, closingBalance: parsed.closingBalance }
    } else if (body.source === 'csv') {
      if (!body.mapping || body.mapping.date == null || body.mapping.amount == null || body.mapping.description == null) {
        return NextResponse.json({ error: 'CSV column mapping (date, amount, description) required' }, { status: 400 })
      }
      lines = parseCsv(sourceContent, body.mapping)
    } else if (body.source === 'camt053' || body.source === 'bai2' || body.source === 'mt940') {
      const parsed =
        body.source === 'camt053' ? parseCamt053(sourceContent)
        : body.source === 'bai2' ? parseBai2(sourceContent)
        : parseMt940(sourceContent)
      lines = parsed.lines
      meta = { currency: parsed.currency, statementDate: parsed.statementDate, closingBalance: parsed.closingBalance }
    } else {
      return NextResponse.json({ error: 'source must be ofx, csv, camt053, bai2 or mt940' }, { status: 400 })
    }

    const openingBalance = persistMoney(body.openingBalance)
    if (openingBalance === 'invalid') {
      return NextResponse.json({ error: 'Opening balance must be an exact decimal' }, { status: 422 })
    }
    const closingFromRequest = persistMoney(body.closingBalance)
    if (closingFromRequest === 'invalid') {
      return NextResponse.json({ error: 'Closing balance must be an exact decimal' }, { status: 422 })
    }

    const result = await importStatement(
      {
        accountId: body.accountId,
        source: body.source,
        lines,
        statementDate: body.statementDate ?? meta.statementDate ?? null,
        openingBalance,
        closingBalance: closingFromRequest ?? meta.closingBalance ?? null,
        currency: meta.currency ?? null,
        sourceEvidence: {
          content: sourceContent,
          filename: typeof body.filename === 'string' ? body.filename : null,
          ...(typeof body.contentType === 'string' ? { contentType: body.contentType } : {}),
          parserVersion: BANK_STATEMENT_PARSER_VERSION,
          csvMapping: body.source === 'csv' ? body.mapping : null,
        },
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
      sourceEvidenceRef: result.sourceEvidenceRef,
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
