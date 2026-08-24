/** Transaction (document-by-kind) import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { postDocument } from '@openbooks/engine/src/posting.ts'
import { controlDeps, nextDocumentNumber } from '../documents'
import { createPermission, postPermission, readPermission, type DocKindConfig } from '../document-kinds'
import { canonicalDecimal } from '../exact-decimal'
import {
  MAX_EXPORT_ROWS,
  orgFeatureEnabled,
  RefResolver,
  type DataResource,
  type WriteCtx,
} from './resource-core'
import {
  type CellValue,
  type ResourceDescriptor,
  type ResourceField,
  type WriteOutcome,
} from './types'
// --- Transaction resources (documents by kind) --------------------------------

/**
 * A line-based posting document (bill, invoice, card charge, …). Transactions
 * are inherently multi-line, so the natural import format is JSON with a nested
 * `lines` array; a flat CSV row is also accepted as a single-line document.
 *
 * Import is INSERT-only (never rewrites a posted document). Each row creates a
 * DRAFT via the same helpers the drawer uses (nextDocumentNumber), then — only
 * when the importer asks to post AND the caller holds the kind's post
 * permission — routes through postDocument. A posting failure leaves the draft
 * intact for review rather than corrupting the ledger.
 */
function transactionFields(cfg: DocKindConfig): ResourceField[] {
  const fields: ResourceField[] = [
    { key: 'documentNumber', label: 'documentNumber', kind: 'text' },
    { key: 'documentDate', label: 'documentDate', kind: 'date', required: true },
  ]
  if (cfg.hasDueDate) fields.push({ key: 'dueDate', label: 'dueDate', kind: 'date' })
  if (cfg.partyRole)
    fields.push({
      key: 'party',
      label: cfg.partyRole,
      kind: 'reference',
      required: true,
      ref: { resource: 'parties', by: 'short_code' },
    })
  if (cfg.hasReference) fields.push({ key: 'reference', label: 'reference', kind: 'text' })
  fields.push({ key: 'currency', label: 'currency', kind: 'text' })
  fields.push({ key: 'memo', label: 'memo', kind: 'long_text' })
  // Single-line convenience columns (flat CSV): one line per document.
  fields.push({ key: 'account', label: 'account', kind: 'reference', ref: { resource: 'accounts', by: 'number' } })
  fields.push({ key: 'amount', label: 'amount', kind: 'currency' })
  fields.push({ key: 'description', label: 'description', kind: 'text' })
  if (cfg.hasTax) fields.push({ key: 'taxCode', label: 'taxCode', kind: 'reference', ref: { resource: 'tax-codes', by: 'code' } })
  // Multi-line: a JSON array of { account, amount, description?, taxCode? }.
  fields.push({ key: 'lines', label: 'lines', kind: 'long_text' })
  return fields
}

export function transactionDescriptor(cfg: DocKindConfig): ResourceDescriptor {
  return {
    key: `txn:${cfg.kind}`,
    label: cfg.kind,
    group: 'Transactions',
    iconKey: cfg.family === 'ar' ? 'clipboard-check' : cfg.family === 'bank' ? 'building' : 'clipboard',
    readPermission: readPermission(cfg.kind),
    writePermission: createPermission(cfg.kind),
    supportsImport: true,
    naturalKey: 'documentNumber',
    canPost: true,
    postPermission: postPermission(cfg.kind),
  }
}

interface TxnLineInput {
  account?: unknown
  amount?: unknown
  description?: unknown
  taxCode?: unknown
  quantity?: unknown
  unitPrice?: unknown
}

export function transactionResource(cfg: DocKindConfig, orgId: string): DataResource {
  const cols = transactionFields(cfg)
  return {
    descriptor: transactionDescriptor(cfg),
    async fields() {
      if (await orgFeatureEnabled(orgId, 'multiCurrency')) return cols
      return cols.filter((f) => f.key !== 'currency')
    },
    async columns() {
      // Export shape: header fields + a JSON `lines` column (skip the flat
      // single-line convenience inputs, which are import-only sugar).
      return cols
        .filter((f) => !['account', 'amount', 'description', 'taxCode'].includes(f.key))
        .map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const resolver = new RefResolver(orgId)
      const docs = (await db.execute(sql`
        select d.id, d.document_number, d.document_date, d.due_date, d.currency, d.memo,
               d.reference_number, d.status, p.short_code as party
          from documents d left join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${orgId} and d.kind = ${cfg.kind}
         order by d.document_date desc, d.document_number
         limit ${MAX_EXPORT_ROWS}`)) as {
        rows: {
          id: string
          document_number: string
          document_date: string
          due_date: string | null
          currency: string
          memo: string | null
          reference_number: string | null
          status: string
          party: string | null
        }[]
      }
      const rows: Record<string, CellValue>[] = []
      for (const d of docs.rows) {
        const lineRows = (await db.execute(sql`
          select l.amount, l.description, a.number as account, t.code as tax_code
            from document_lines l
            left join accounts a on a.id = l.account_id and a.org_id = l.org_id
            left join tax_codes t on t.id = l.tax_code_id and t.org_id = l.org_id
           where l.document_id = ${d.id} and l.org_id = ${orgId} order by l.line_number`)) as {
          rows: { amount: string; description: string | null; account: string | null; tax_code: string | null }[]
        }
        rows.push({
          documentNumber: d.document_number,
          documentDate: d.document_date,
          dueDate: d.due_date,
          party: d.party,
          reference: d.reference_number,
          currency: d.currency,
          memo: d.memo,
          status: d.status,
          lines: JSON.stringify(
            lineRows.rows.map((l) => ({
              account: l.account,
              amount: l.amount,
              description: l.description,
              taxCode: l.tax_code,
            })),
          ),
        })
      }
      void resolver
      const columns = [
        { key: 'documentNumber', label: 'documentNumber' },
        { key: 'documentDate', label: 'documentDate' },
        { key: 'dueDate', label: 'dueDate' },
        { key: 'party', label: 'party' },
        { key: 'reference', label: 'reference' },
        { key: 'currency', label: 'currency' },
        { key: 'memo', label: 'memo' },
        { key: 'status', label: 'status' },
        { key: 'lines', label: 'lines' },
      ]
      return { fields: cols, columns, rows }
    },
    async write(rows, _mode, ctx) {
      return writeTransactions(cfg, rows, ctx)
    },
  }
}

async function writeTransactions(
  cfg: DocKindConfig,
  rows: Record<string, unknown>[],
  ctx: WriteCtx,
): Promise<WriteOutcome> {
  const resolver = new RefResolver(ctx.orgId)
  const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
  const baseCurrency = ((await db.execute(sql`select base_currency from orgs where id = ${ctx.orgId}`)) as {
    rows: { base_currency: string }[]
  }).rows[0]?.base_currency ?? 'CAD'
  const multiCurrencyOn = await orgFeatureEnabled(ctx.orgId, 'multiCurrency')
  const deps = ctx.post ? await controlDeps(ctx.orgId) : null

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 1
    const src = rows[i]!
    try {
      if (src.currency !== undefined && !multiCurrencyOn) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: 'currency is not available' })
        continue
      }
      const documentDate = String(src.documentDate ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(documentDate)) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: 'documentDate must be YYYY-MM-DD' })
        continue
      }

      // Party (required for AP/AR kinds).
      let partyId: string | null = null
      if (cfg.partyRole) {
        const human = src.party
        if (!human) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: `${cfg.partyRole} is required` })
          continue
        }
        partyId = await resolver.resolveId({ resource: 'parties', by: 'short_code' }, human)
        if (!partyId) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: `${cfg.partyRole} "${String(human)}" not found` })
          continue
        }
      }

      // Assemble lines (JSON `lines` wins; else the flat single-line columns).
      const rawLines: TxnLineInput[] = parseLines(src)
      if (rawLines.length === 0) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: 'at least one line (account + amount) is required' })
        continue
      }
      const built: { accountId: string; amount: string; description: string | null; taxCodeId: string | null }[] = []
      let lineErr: string | null = null
      for (const l of rawLines) {
        const acctId = await resolver.resolveId({ resource: 'accounts', by: 'number' }, l.account)
        if (!acctId) {
          lineErr = `account "${String(l.account ?? '')}" not found`
          break
        }
        const amount = exactLineAmount(l.amount)
        if (amount === null) {
          lineErr =
            `line amount "${String(l.amount ?? '')}" must be an exact decimal with at most 4 decimal places`
          break
        }
        let taxCodeId: string | null = null
        if (l.taxCode) {
          taxCodeId = await resolver.resolveId({ resource: 'tax-codes', by: 'code' }, l.taxCode)
          if (!taxCodeId) {
            lineErr = `tax code "${String(l.taxCode)}" not found`
            break
          }
        }
        built.push({ accountId: acctId, amount, description: l.description ? String(l.description) : null, taxCodeId })
      }
      if (lineErr) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: lineErr })
        continue
      }

      // Duplicate document number?
      const wantNumber = String(src.documentNumber ?? '').trim()
      if (wantNumber) {
        const dup = (await db.execute(sql`
          select 1 from documents where org_id = ${ctx.orgId} and kind = ${cfg.kind} and document_number = ${wantNumber} limit 1`)) as {
          rows: unknown[]
        }
        if (dup.rows.length > 0) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: `document ${wantNumber} already exists` })
          continue
        }
      }

      if (ctx.dryRun) {
        outcome.created++
        continue
      }

      // Create the draft document + lines.
      const number = wantNumber || (await nextDocumentNumber(ctx.orgId, cfg.kind, cfg.numberPrefix))
      const currency = String(src.currency ?? '').trim() || baseCurrency
      const documentId = await db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(schema.documents)
          .values({
            orgId: ctx.orgId,
            kind: cfg.kind,
            documentNumber: number,
            partyId,
            documentDate,
            dueDate: cfg.hasDueDate && src.dueDate ? String(src.dueDate) : null,
            currency,
            referenceNumber: cfg.hasReference && src.reference ? String(src.reference) : null,
            memo: src.memo ? String(src.memo) : null,
            status: 'draft',
            createdBy: ctx.actorId,
          })
          .returning({ id: schema.documents.id })
        if (!doc) throw new Error('document insert did not return an id')

        await tx.insert(schema.documentLines).values(
          built.map((l, idx) => ({
            orgId: ctx.orgId,
            documentId: doc.id,
            lineNumber: idx + 1,
            accountId: l.accountId,
            description: l.description,
            amount: l.amount,
            taxCodeId: l.taxCodeId,
            createdBy: ctx.actorId,
          })),
        )
        return doc.id
      })

      if (ctx.post && deps) {
        try {
          await postDocument(documentId, deps)
        } catch (e) {
          // Draft persists for review; report why posting failed.
          outcome.created++
          outcome.errors.push({ row: rowNo, message: `created draft ${number}, but posting failed: ${(e as Error).message}` })
          continue
        }
      }
      outcome.created++
    } catch (e) {
      outcome.failed++
      outcome.errors.push({ row: rowNo, message: (e as { message?: string })?.message ?? 'write failed' })
    }
  }
  return outcome
}

function exactLineAmount(value: unknown): string | null {
  if (
    typeof value !== 'string' &&
    (typeof value !== 'number' || !Number.isSafeInteger(value))
  ) {
    return null
  }
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return null
  try {
    return normalizeMoney(exact)
  } catch {
    return null
  }
}

function parseLines(src: Record<string, unknown>): TxnLineInput[] {
  const raw = src.lines
  if (raw !== undefined && raw !== null && raw !== '') {
    try {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (Array.isArray(arr)) return arr as TxnLineInput[]
    } catch {
      /* fall through to single-line */
    }
  }
  if (src.account && src.amount !== undefined && src.amount !== '') {
    return [{ account: src.account, amount: src.amount, description: src.description, taxCode: src.taxCode }]
  }
  return []
}
