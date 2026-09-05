import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// documents.ts and bills.ts are server-only services (they pull the engine's
// DB pool and the flows engine), so the runner cannot import them as-is. The
// marker package gates only RSC bundling; shimming it to an empty module lets
// these tests exercise the production services directly. node's test runner
// isolates each file in its own process, so the hook cannot leak elsewhere.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const {
  applyDocumentEdit,
  assertDocumentEditRevision,
  buildReversalLinkEvidence,
  createPostedCorrectionDraft,
  DocumentEditError,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
  runPostedCorrectionDraftFlows,
  validateCorrectionReason,
  validateEditableDocumentLines,
} = await import('./documents.ts')
const { computeBillTotals } = await import('./bills.ts')
const { createRecord } = await import('./api/writers.ts')
const { saveTaxRateProviderConfig } = await import('@openbooks/engine/src/tax-rate-providers.ts')
const { withSimClock } = await import('@openbooks/engine/src/clock.ts')
const {
  DocumentVoidError,
  requestDocumentVoid,
} = await import('@openbooks/engine/src/document-void.ts')
const { db, env, pool, withBypass, withOrgContext, withOrgTransaction } = await import('@openbooks/engine/src/db.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')
const {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} = await import('@openbooks/engine/src/test-fixtures.ts')
const { createApplicationRecord } = await import('./application/records.ts')
const { correctPostedDocument } = await import('./application/documents.ts')

const NO_PROFILES = { codes: new Map(), groups: new Map() }
const DOCUMENTS_SOURCE = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8')

async function listenProvider(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('provider test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function consumeRequest(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => undefined)
    req.on('end', resolve)
    req.on('error', reject)
  })
}

async function closeProvider(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

type StoredDocument = {
  kind: string
  status: string
  total: string
  taxTotal: string
  partyId: string | null
  documentDate: string
  updatedAt: string
  memo: string | null
}

type Settled<Result> =
  | { status: 'fulfilled'; value: Result }
  | { status: 'rejected'; reason: unknown }

function settle<Result>(work: Promise<Result>): Promise<Settled<Result>> {
  return work.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
}

function isConflict(error: unknown): boolean {
  return error instanceof DocumentEditError && error.status === 409
}

function errorChainIncludes(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error && pattern.test(current.message)) return true
    current = typeof current === 'object' && current !== null && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : null
  }
  return false
}

async function loadStoredDocument(orgId: string, id: string): Promise<StoredDocument> {
  const result = await withOrgContext(orgId, async () => db.execute<StoredDocument>(sql`
    select kind, status, total::text as "total", tax_total::text as "taxTotal",
           party_id as "partyId", document_date::text as "documentDate", memo,
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "updatedAt"
      from documents
     where org_id = ${orgId} and id = ${id}
  `))
  assert.ok(result.rows[0], `document ${id} should exist`)
  return result.rows[0]
}

function pids(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number)
  return String(value ?? '')
    .replace(/^\{|\}$/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number)
}

async function waitForBlockedWriter(
  possibleBlockers: ReadonlySet<number>,
  excludedPids: ReadonlySet<number> = new Set(),
): Promise<{ pid: number; query: string; blockingPids: number[] }> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await withBypass(async () => (await db.execute<{
      pid: number
      query: string
      blockingPids: unknown
    }>(sql`
      select pid, query, pg_blocking_pids(pid) as "blockingPids"
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and cardinality(pg_blocking_pids(pid)) > 0
    `)).rows)
    for (const row of rows) {
      const blockingPids = pids(row.blockingPids)
      if (
        !excludedPids.has(Number(row.pid))
        && blockingPids.some((pid) => possibleBlockers.has(pid))
        && /for\s+update/i.test(row.query)
      ) {
        return { pid: Number(row.pid), query: row.query, blockingPids }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `timed out waiting for a SELECT FOR UPDATE blocked by PostgreSQL pid(s) ${[...possibleBlockers].join(', ')}`,
  )
}

test('negative and zero lines survive editor validation untouched', () => {
  const lines = validateEditableDocumentLines([
    { accountId: 'acc-1', amount: '100.00' },
    { accountId: 'acc-2', amount: '-40.00' },
    { accountId: 'acc-3', amount: '0' },
  ])
  assert.deepEqual(lines.map((l) => l.amount), ['100.00', '-40.00', '0'])
})

test('a line without an account fails closed with its line number', () => {
  assert.throws(
    () => validateEditableDocumentLines([
      { accountId: 'acc-1', amount: '10.00' },
      { accountId: null, amount: '5.00' } as never,
    ]),
    (e: unknown) =>
      e instanceof DocumentEditError && e.status === 422 && /Line 2/.test(e.message),
  )
})

test('a malformed or over-precise amount fails closed with its line number', () => {
  for (const [index, bad] of ['12ab', '', '1.00001'].entries()) {
    assert.throws(
      () => validateEditableDocumentLines([{ accountId: 'acc-1', amount: bad }]),
      (e: unknown) => e instanceof DocumentEditError && e.status === 422 && /Line 1/.test(e.message),
      `amount ${JSON.stringify(bad)} (case ${index}) should be rejected`,
    )
  }
})

test('computeBillTotals carries negative and zero lines into the totals', () => {
  const computed = computeBillTotals([
    { accountId: 'acc-1', amount: '100.00' },
    { accountId: 'acc-2', amount: '-40.00' },
    { accountId: 'acc-3', amount: '0' },
  ], NO_PROFILES)
  assert.equal(computed.subtotal, '60.0000')
  assert.equal(computed.taxTotal, '0.0000')
  assert.equal(computed.total, '60.0000')
})

test('the generic editor no longer filters lines by positive amount', () => {
  // Regression pin (source-level, like wip-billing.test.ts): the save path
  // must validate every submitted line, never silently drop non-positive ones.
  assert.doesNotMatch(DOCUMENTS_SOURCE, /const valid = body\.lines\.filter/)
})

test(
  'PostgreSQL enforces exact, atomic document optimistic concurrency',
  { skip: !env.OPENBOOKS_DB_URL },
  async (t) => {
    const missingId = randomUUID()
    const nullId = randomUUID()
    const exactConflictId = randomUUID()
    const serializedId = randomUUID()
    const rollbackId = randomUUID()
    const rollbackLineId = randomUUID()
    const correctionSourceId = randomUUID()
    const correctionEntryId = randomUUID()
    const applicationCorrectionSourceId = randomUUID()
    const voidRollbackSourceId = randomUUID()
    const createFlowId = randomUUID()
    const correctionFlowId = randomUUID()
    const correctionFlowGuard = `occ_correction_flow_${correctionFlowId.replaceAll('-', '')}`

    const fixture = await withBypass(async () => {
      const org = await createScratchOrg()
      const actorId = (await seedFlowActors(org.orgId)).adminId

      const insertDraft = async (
        id: string,
        number: string,
        revision: string,
        memo: string,
      ) => db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date,
           currency, status, subtotal, tax_total, total, memo, custom,
           extra_dims, created_by, created_at, updated_at, updated_by)
        values
          (${id}, ${org.orgId}, 'transfer', ${number}, ${org.subsidiaryId},
           ${org.date}, 'CAD', 'draft', '0', '0', '0', ${memo}, '{}'::jsonb,
           '{}'::jsonb, ${actorId}, ${revision}::timestamptz,
           ${revision}::timestamptz, null)
      `)

      await insertDraft(missingId, 'OCC-MISSING', '2026-08-24T12:00:00.100001Z', 'missing retained')
      await insertDraft(nullId, 'OCC-NULL', '2026-08-24T12:00:00.100002Z', 'null retained')
      await insertDraft(exactConflictId, 'OCC-EXACT', '2026-08-24T12:00:00.123001Z', 'opened value')
      await insertDraft(serializedId, 'OCC-SERIAL', '2026-08-24T12:00:00.500001Z', 'serialized original')
      await insertDraft(rollbackId, 'OCC-ROLLBACK', '2026-08-24T12:00:00.700001Z', 'rollback header')
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, account_id, description,
           quantity, unit_price, amount, tax_input_amount, tax_amount,
           tax_overridden, extra_dims, custom)
        values
          (${rollbackLineId}, ${org.orgId}, ${rollbackId}, 1,
           ${org.accounts.bank}, 'original line', '1', '7', '7', '7', '0',
           false, '{}'::jsonb, '{}'::jsonb)
      `)

      await insertDraft(
        correctionSourceId,
        'OCC-CORRECTION-SOURCE',
        '2026-08-24T12:00:00.900001Z',
        'posted source',
      )
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin, custom,
           created_by, updated_by)
        values
          (${correctionEntryId}, ${org.orgId}, ${org.bookId},
           ${org.subsidiaryId}, 'OCC-CORRECTION-ENTRY', ${org.date},
           ${org.periodId}, 'posted source identity', 'draft',
           ${correctionSourceId}, 'document', '{}'::jsonb, ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        update documents
           set status = 'posted', posted_entry_id = ${correctionEntryId},
               posting_period_id = ${org.periodId}, posting_date = ${org.date}
         where id = ${correctionSourceId} and org_id = ${org.orgId}
      `)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status, subtotal,
           tax_total, total, memo, custom, extra_dims, created_by, updated_by)
        values
          (${applicationCorrectionSourceId}, ${org.orgId}, 'vendor_bill',
           'OCC-APPLICATION-CORRECTION', ${org.vendorId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', '1', 'draft', '125', '0', '125',
           'application correction source', '{}'::jsonb, '{}'::jsonb,
           ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, extra_dims, custom, created_by, updated_by)
        values
          (${org.orgId}, ${applicationCorrectionSourceId}, 1,
           ${org.accounts.cogs}, '1', '125', '125', '0', '{}'::jsonb,
           '{}'::jsonb, ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        update documents set status = 'approved'
         where id = ${applicationCorrectionSourceId} and org_id = ${org.orgId}
      `)
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, party_id, subsidiary_id,
           document_date, posting_date, currency, fx_rate, status, subtotal,
           tax_total, total, memo, custom, extra_dims, created_by, updated_by)
        values
          (${voidRollbackSourceId}, ${org.orgId}, 'vendor_bill',
           'OCC-VOID-ROLLBACK', ${org.vendorId}, ${org.subsidiaryId},
           ${org.date}, ${org.date}, 'CAD', '1', 'draft', '125', '0', '125',
           'void rollback source', '{}'::jsonb, '{}'::jsonb,
           ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, extra_dims, custom, created_by, updated_by)
        values
          (${org.orgId}, ${voidRollbackSourceId}, 1,
           ${org.accounts.cogs}, '1', '125', '125', '0', '{}'::jsonb,
           '{}'::jsonb, ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        update documents set status = 'approved'
         where id = ${voidRollbackSourceId} and org_id = ${org.orgId}
      `)
      await db.execute(sql`
        insert into flows
          (id, org_id, name, subject_kind, enabled, graph, created_by, updated_by)
        values
          (${createFlowId}, ${org.orgId}, 'OCC create settlement',
           'customer_invoice', true, ${JSON.stringify({
             schemaVersion: 1,
             nodes: [
               {
                 id: 'created',
                 position: { x: 0, y: 0 },
                 data: { kind: 'trigger', trigger: { trigger: 'on_create' } },
               },
               {
                 id: 'settled-field',
                 position: { x: 200, y: 0 },
                 data: {
                   kind: 'action',
                   action: {
                     action: 'set_field',
                     field: 'internalNotes',
                     value: { kind: 'literal', value: 'settled by on_create' },
                   },
                 },
               },
             ],
             edges: [
               { id: 'created-to-field', source: 'created', target: 'settled-field' },
             ],
          })}::jsonb, ${actorId}, ${actorId})
      `)
      await db.execute(sql`
        insert into flows
          (id, org_id, name, subject_kind, enabled, graph, created_by, updated_by)
        values
          (${correctionFlowId}, ${org.orgId}, 'OCC correction transactional',
           'vendor_bill', true, ${JSON.stringify({
             schemaVersion: 1,
             nodes: [
               {
                 id: 'created',
                 position: { x: 0, y: 0 },
                 data: { kind: 'trigger', trigger: { trigger: 'on_create' } },
               },
               {
                 id: 'notify',
                 position: { x: 200, y: 0 },
                 data: {
                   kind: 'action',
                   action: {
                     action: 'notify',
                     to: [{ type: 'user', userId: actorId }],
                     title: 'Correction committed',
                   },
                 },
               },
             ],
             edges: [{ id: 'created-to-notify', source: 'created', target: 'notify' }],
           })}::jsonb, ${actorId}, ${actorId})
      `)
      await db.execute(sql.raw(`
        create function public.${correctionFlowGuard}_fn() returns trigger
        language plpgsql as $guard$
        begin
          if new.flow_id = '${correctionFlowId}'::uuid and not exists (
            select 1
              from document_links link
             where link.org_id = new.org_id
               and link.from_document_id = new.subject_id
               and link.xmin::text::bigint = txid_current()
          ) then
            raise exception 'correction flow dispatched after correction transaction committed';
          end if;
          return new;
        end
        $guard$;
        create trigger ${correctionFlowGuard}
          before insert on flow_runs
          for each row execute function public.${correctionFlowGuard}_fn();
      `))

      return { actorId, org }
    })

    const { actorId, org } = fixture
    const editContext = {
      orgId: org.orgId,
      userId: actorId,
      source: 'ui' as const,
      runFlows: false,
    }

    try {
      await withOrgContext(org.orgId, () => postDocument(
        applicationCorrectionSourceId,
        {
          control: {
            ar: org.accounts.ar,
            ap: org.accounts.ap,
            bank: org.accounts.bank,
          },
        },
        { audit: { actorId, source: 'test' } },
      ))

      await t.test('pristine existing drafts reject missing and null revisions', async () => {
        for (const [id, expectedMemo, expectedUpdatedAt, body] of [
          [missingId, 'missing retained', '2026-08-24T12:00:00.100001Z', { memo: 'missing bypassed' }],
          [nullId, 'null retained', '2026-08-24T12:00:00.100002Z', {
            expectedUpdatedAt: null as never,
            memo: 'null bypassed',
          }],
        ] as const) {
          const stored = await loadStoredDocument(org.orgId, id)
          const { updatedAt: _omittedRevision, memo: _memo, ...currentWithoutRevision } = stored
          await assert.rejects(
            withOrgContext(org.orgId, () => applyDocumentEdit(
              id,
              currentWithoutRevision as never,
              body,
              editContext,
            )),
            isConflict,
          )
          const retained = await loadStoredDocument(org.orgId, id)
          assert.equal(retained.memo, expectedMemo)
          assert.equal(retained.updatedAt, expectedUpdatedAt)
        }
      })

      await t.test('same-millisecond PostgreSQL microseconds produce a real stale conflict', async () => {
        const opened = await loadStoredDocument(org.orgId, exactConflictId)
        assert.equal(opened.updatedAt, '2026-08-24T12:00:00.123001Z')
        assert.equal(
          new Date(opened.updatedAt).getTime(),
          new Date('2026-08-24T12:00:00.123999Z').getTime(),
          'JavaScript Date intentionally cannot distinguish these database revisions',
        )

        await withOrgContext(org.orgId, async () => {
          await db.execute(sql`
            update documents
               set memo = 'concurrent exact update',
                   updated_at = '2026-08-24T12:00:00.123999Z'::timestamptz,
                   updated_by = ${actorId}
             where id = ${exactConflictId} and org_id = ${org.orgId}
          `)
        })

        await assert.rejects(
          withOrgContext(org.orgId, () => applyDocumentEdit(
            exactConflictId,
            opened,
            { expectedUpdatedAt: opened.updatedAt, memo: 'stale overwrite' },
            editContext,
          )),
          isConflict,
        )
        const retained = await loadStoredDocument(org.orgId, exactConflictId)
        assert.equal(retained.memo, 'concurrent exact update')
        assert.equal(retained.updatedAt, '2026-08-24T12:00:00.123999Z')
      })

      await t.test('storage refuses to let two writes share one revision token', async () => {
        // Regression pin for the audited collapse: writers whose timestamp
        // source truncates PostgreSQL's microseconds (JavaScript Date) or
        // repeats `now()` inside one transaction could store an updated_at
        // byte-identical to the one already on the row. Two distinct
        // revisions then serialized to one expectedUpdatedAt token and stale
        // writes evaded detection. The documents_revision_monotonic trigger
        // rewrites exactly that shape forward; nothing else about an explicit
        // timestamp write changes.
        const collapseId = randomUUID()
        await withBypass(async () => {
          await db.execute(sql`
            insert into documents
              (id, org_id, kind, document_number, subsidiary_id, document_date,
               currency, status, subtotal, tax_total, total, memo, custom,
               extra_dims, created_by, created_at, updated_at, updated_by)
            values
              (${collapseId}, ${org.orgId}, 'transfer', 'OCC-COLLAPSE',
               ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '0', '0', '0',
               'collapse probe', '{}'::jsonb, '{}'::jsonb, ${actorId},
               '2026-08-24T12:00:00.400001Z'::timestamptz,
               '2026-08-24T12:00:00.400001Z'::timestamptz, null)
          `)
        })

        const opened = await loadStoredDocument(org.orgId, collapseId)
        assert.equal(opened.updatedAt, '2026-08-24T12:00:00.400001Z')
        await withOrgContext(org.orgId, async () => {
          await db.execute(sql`
            update documents
               set memo = 'repeat attempt',
                   updated_at = ${opened.updatedAt}::timestamptz
             where id = ${collapseId} and org_id = ${org.orgId}
          `)
        })
        const afterRepeat = await loadStoredDocument(org.orgId, collapseId)
        assert.equal(afterRepeat.memo, 'repeat attempt')
        assert.notEqual(
          afterRepeat.updatedAt,
          opened.updatedAt,
          'a write repeating the stored revision must receive a fresh token',
        )
        assert.match(afterRepeat.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)

        // Two updates inside one transaction share now() by construction;
        // only the storage rule keeps their committed revisions distinct.
        await withOrgContext(org.orgId, () => db.transaction(async (tx) => {
          for (const memo of ['same transaction write one', 'same transaction write two']) {
            await tx.execute(sql`
              update documents
                 set memo = ${memo}, updated_at = now()
               where id = ${collapseId} and org_id = ${org.orgId}
            `)
          }
        }))
        const afterSameTransaction = await loadStoredDocument(org.orgId, collapseId)
        assert.equal(afterSameTransaction.memo, 'same transaction write two')
        assert.notEqual(
          afterSameTransaction.updatedAt,
          afterRepeat.updatedAt,
          'two writes in one transaction may never commit one shared revision token',
        )

        // A stale holder of the pre-collapse token is rejected against the
        // advanced revision, proving the tokens really do distinguish the
        // writes that previously collapsed together.
        await assert.rejects(
          withOrgContext(org.orgId, () => applyDocumentEdit(
            collapseId,
            {
              kind: opened.kind,
              status: opened.status,
              total: opened.total,
              taxTotal: opened.taxTotal,
              partyId: opened.partyId,
              documentDate: opened.documentDate,
              updatedAt: opened.updatedAt,
            },
            { expectedUpdatedAt: opened.updatedAt, memo: 'stale overwrite' },
            editContext,
          )),
          isConflict,
        )
      })

      await t.test('SELECT FOR UPDATE serializes two writers from one exact revision', async () => {
        const opened = await loadStoredDocument(org.orgId, serializedId)
        const blocker = await withOrgContext(org.orgId, async () => pool.connect())
        let blockerCommitted = false
        let firstWrite: Promise<Settled<void>> | undefined
        let secondWrite: Promise<Settled<void>> | undefined
        let results: [Settled<void>, Settled<void>] | undefined
        try {
          await blocker.query('begin')
          await blocker.query(
            "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
            [org.orgId],
          )
          const backend = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
          const blockerPid = Number(backend.rows[0]!.pid)
          await blocker.query(
            'select id from documents where org_id = $1 and id = $2 for update',
            [org.orgId, serializedId],
          )

          firstWrite = settle(withOrgContext(org.orgId, () => applyDocumentEdit(
            serializedId,
            opened,
            { expectedUpdatedAt: opened.updatedAt, memo: 'first writer' },
            editContext,
          )))
          const firstBlocked = await waitForBlockedWriter(new Set([blockerPid]))
          assert.deepEqual(firstBlocked.blockingPids.includes(blockerPid), true)

          secondWrite = settle(withOrgContext(org.orgId, () => applyDocumentEdit(
            serializedId,
            opened,
            { expectedUpdatedAt: opened.updatedAt, memo: 'stale writer' },
            editContext,
          )))
          const secondBlocked = await waitForBlockedWriter(
            new Set([blockerPid, firstBlocked.pid]),
            new Set([firstBlocked.pid]),
          )
          assert.notEqual(secondBlocked.pid, firstBlocked.pid)

          await blocker.query('commit')
          blockerCommitted = true
          results = await Promise.all([firstWrite, secondWrite])
        } finally {
          if (!blockerCommitted) await blocker.query('rollback').catch(() => undefined)
          blocker.release()
          if (!results) {
            await Promise.all([firstWrite, secondWrite].filter(Boolean) as Promise<Settled<void>>[])
          }
        }

        assert.ok(results)
        assert.equal(results[0].status, 'fulfilled')
        assert.equal(results[1].status, 'rejected')
        assert.ok(results[1].status === 'rejected' && isConflict(results[1].reason))
        const saved = await loadStoredDocument(org.orgId, serializedId)
        assert.equal(saved.memo, 'first writer')
        assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
        assert.notEqual(saved.updatedAt, opened.updatedAt)
      })

      await t.test('a failed second replacement line rolls the entire edit back', async () => {
        const opened = await loadStoredDocument(org.orgId, rollbackId)
        const invalidAccountId = randomUUID()
        await assert.rejects(
          withOrgContext(org.orgId, () => applyDocumentEdit(
            rollbackId,
            opened,
            {
              expectedUpdatedAt: opened.updatedAt,
              memo: 'header must roll back',
              lines: [
                { accountId: org.accounts.cogs, description: 'inserted before failure', amount: '12' },
                { accountId: invalidAccountId, description: 'foreign-key failure', amount: '3' },
              ],
            },
            editContext,
          )),
          (error: unknown) => errorChainIncludes(
            error,
            /document_lines_account_id_fkey|violates foreign key constraint/,
          ),
        )

        const retained = await loadStoredDocument(org.orgId, rollbackId)
        assert.equal(retained.memo, 'rollback header')
        assert.equal(retained.updatedAt, opened.updatedAt)
        const lines = await withOrgContext(org.orgId, async () => (await db.execute<{
          id: string
          accountId: string
          description: string
          amount: string
        }>(sql`
          select id, account_id as "accountId", description, amount::text
            from document_lines
           where org_id = ${org.orgId} and document_id = ${rollbackId}
           order by line_number
        `)).rows)
        assert.deepEqual(lines, [{
          id: rollbackLineId,
          accountId: org.accounts.bank,
          description: 'original line',
          amount: '7.0000',
        }])
      })

      await t.test('API and MCP creation reload the revision settled by on_create flows', async () => {
        const user = {
          id: actorId,
          email: 'occ-writer@scratch.test',
          name: 'OCC Writer',
          roles: [{ key: 'admin', name: 'Admin' }],
          orgId: org.orgId,
          envKind: 'production' as const,
          productionOrgId: org.orgId,
          isSuperAdmin: false,
          homeUserId: actorId,
          homeOrgId: org.orgId,
        }

        for (const source of ['api', 'mcp'] as const) {
          const writeResult = await withOrgContext(
            org.orgId,
            () => createApplicationRecord(
              {
                authz: {
                  user,
                  permissions: new Set(['*']),
                  allowedSubsidiaryIds: null,
                },
                source,
                requestId: `occ-create-${source}`,
                apiKeyId: null,
              },
              {
                typeKey: 'invoices',
                body: { memo: `${source} request persisted` },
                idempotencyKey: `occ-create-${source}-0001`,
              },
            ),
          )
          assert.equal(writeResult.status, 201)
          assert.equal(writeResult.replayed, false)
          const payload = writeResult.result as {
            doc: { id: string; memo: string | null; internal_notes: string | null; updated_at: string }
          }
          assert.equal(payload.doc.memo, `${source} request persisted`)
          assert.equal(payload.doc.internal_notes, 'settled by on_create')
          assert.match(payload.doc.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
          const persisted = await loadStoredDocument(org.orgId, payload.doc.id)
          assert.equal(payload.doc.updated_at, persisted.updatedAt)
        }

        const runs = await withOrgContext(org.orgId, async () => (await db.execute<{
          status: string
        }>(sql`
          select status
            from flow_runs
           where org_id = ${org.orgId} and flow_id = ${createFlowId}
             and trigger = 'on_create'
           order by started_at
        `)).rows)
        assert.deepEqual(runs, [
          { status: 'completed' },
          { status: 'completed' },
        ])
      })

      await t.test('concurrent posted corrections retain exactly one winner', async () => {
        const source = await loadStoredDocument(org.orgId, correctionSourceId)
        assert.equal(source.status, 'posted')
        // The draft→posted flip is itself a mutation, so storage has advanced
        // the seeded revision: every committed documents update must move
        // updated_at forward (documents_revision_monotonic trigger), and this
        // correction's OCC evidence must be the current exact token, whatever
        // value the flip produced.
        assert.match(source.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
        assert.notEqual(source.updatedAt, '2026-08-24T12:00:00.900001Z')
        const correctionBody = {
          expectedUpdatedAt: source.updatedAt,
          amendmentReason: 'Correct duplicated allocation',
          memo: 'retained correction',
        }
        const blocker = await withOrgContext(org.orgId, async () => pool.connect())
        type CorrectionResult = Awaited<ReturnType<typeof createPostedCorrectionDraft>>
        let blockerCommitted = false
        let firstAttempt: Promise<Settled<CorrectionResult>> | undefined
        let secondAttempt: Promise<Settled<CorrectionResult>> | undefined
        let attempts: Array<Settled<CorrectionResult>> | undefined
        try {
          await blocker.query('begin')
          await blocker.query(
            "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
            [org.orgId],
          )
          const backend = await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')
          const blockerPid = Number(backend.rows[0]!.pid)
          await blocker.query(
            'select id from documents where org_id = $1 and id = $2 for update',
            [org.orgId, correctionSourceId],
          )

          firstAttempt = settle(withOrgContext(org.orgId, () => createPostedCorrectionDraft(
            correctionSourceId,
            correctionBody,
            editContext,
          )))
          const firstBlocked = await waitForBlockedWriter(new Set([blockerPid]))
          secondAttempt = settle(withOrgContext(org.orgId, () => createPostedCorrectionDraft(
            correctionSourceId,
            correctionBody,
            editContext,
          )))
          await waitForBlockedWriter(
            new Set([blockerPid, firstBlocked.pid]),
            new Set([firstBlocked.pid]),
          )
          await blocker.query('commit')
          blockerCommitted = true
          attempts = await Promise.all([firstAttempt, secondAttempt])
        } finally {
          if (!blockerCommitted) await blocker.query('rollback').catch(() => undefined)
          blocker.release()
          if (!attempts) {
            await Promise.all([firstAttempt, secondAttempt].filter(Boolean) as Array<
              Promise<Settled<CorrectionResult>>
            >)
          }
        }
        assert.ok(attempts)
        assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
        const loser = attempts.find((attempt) => attempt.status === 'rejected')
        assert.ok(loser?.status === 'rejected' && isConflict(loser.reason))

        const links = await withOrgContext(org.orgId, async () => (await db.execute<{
          replacementId: string
          status: string
          memo: string | null
          correctionOf: string | null
        }>(sql`
          select link.from_document_id as "replacementId", replacement.status,
                 replacement.memo, replacement.custom->>'correctionOf' as "correctionOf"
            from document_links link
            join documents replacement
              on replacement.org_id = link.org_id
             and replacement.id = link.from_document_id
           where link.org_id = ${org.orgId}
             and link.to_document_id = ${correctionSourceId}
             and link.link_type = 'reverses'
        `)).rows)
        assert.equal(links.length, 1)
        assert.equal(links[0]!.status, 'draft')
        assert.equal(links[0]!.memo, 'retained correction')
        assert.equal(links[0]!.correctionOf, correctionSourceId)
      })

      await t.test('application correction routes flows inside its idempotent transaction', async () => {
        const source = await loadStoredDocument(org.orgId, applicationCorrectionSourceId)
        assert.equal(source.status, 'posted')
        const user = {
          id: actorId,
          email: 'occ-correction@scratch.test',
          name: 'OCC Correction Controller',
          roles: [{ key: 'admin', name: 'Admin' }],
          orgId: org.orgId,
          envKind: 'production' as const,
          productionOrgId: org.orgId,
          isSuperAdmin: false,
          homeUserId: actorId,
          homeOrgId: org.orgId,
        }
        const correction = {
          expectedUpdatedAt: source.updatedAt,
          amendmentReason: 'Correct duplicated vendor charge',
          partyId: org.vendorId,
          documentDate: org.date,
          memo: 'application correction committed',
          lines: [{ accountId: org.accounts.cogs, amount: '125' }],
        }
        const correctionContext = {
          authz: {
            user,
            permissions: new Set(['*']),
            allowedSubsidiaryIds: null,
          },
          source: 'api' as const,
          requestId: 'occ-application-correction',
          apiKeyId: null,
        }
        const result = await withSimClock(org.date, () => withOrgContext(
          org.orgId,
          () => correctPostedDocument(correctionContext, {
            documentId: applicationCorrectionSourceId,
            correction,
            idempotencyKey: 'occ-correction-postcommit-api-0001',
          }),
        ))
        assert.equal(result.replayed, false)
        const outcome = result.result as { correctionId: string; voidStatus: string }
        assert.match(outcome.correctionId, /^[0-9a-f-]{36}$/)
        assert.equal(outcome.voidStatus, 'voided')

        const committed = await withOrgContext(org.orgId, async () => (await db.execute<{
          sourceStatus: string
          replacementMemo: string | null
          runs: number
          notifications: number
        }>(sql`
          select source.status as "sourceStatus", replacement.memo as "replacementMemo",
                 (select count(*)::int from flow_runs
                   where org_id = ${org.orgId} and flow_id = ${correctionFlowId}) as runs,
                 (select count(*)::int from notifications
                   where org_id = ${org.orgId} and kind = 'flow'
                     and title = 'Correction committed') as notifications
            from documents source
            join document_links link
              on link.org_id = source.org_id
             and link.to_document_id = source.id
             and link.link_type = 'reverses'
            join documents replacement
              on replacement.org_id = link.org_id
             and replacement.id = link.from_document_id
           where source.org_id = ${org.orgId}
             and source.id = ${applicationCorrectionSourceId}
        `)).rows[0])
        assert.deepEqual(committed, {
          sourceStatus: 'voided',
          replacementMemo: 'application correction committed',
          runs: 1,
          notifications: 1,
        })

        // A completed key replays the committed response even though the
        // source is now voided. The callback (and therefore flow dispatch)
        // must not run a second time.
        const replay = await withSimClock(org.date, () => withOrgContext(
          org.orgId,
          () => correctPostedDocument(correctionContext, {
            documentId: applicationCorrectionSourceId,
            correction,
            idempotencyKey: 'occ-correction-postcommit-api-0001',
          }),
        ))
        assert.equal(replay.replayed, true)
        assert.deepEqual(replay.result, result.result)
        const replayEffects = await withOrgContext(org.orgId, async () => (await db.execute<{
          runs: number
          notifications: number
        }>(sql`
          select
            (select count(*)::int from flow_runs
              where org_id = ${org.orgId} and flow_id = ${correctionFlowId}) as runs,
            (select count(*)::int from notifications
              where org_id = ${org.orgId} and kind = 'flow'
                and title = 'Correction committed') as notifications
        `)).rows[0])
        assert.deepEqual(replayEffects, { runs: 1, notifications: 1 })
      })

      await t.test('flow routing failure rolls back correction, void, and idempotency claim', async () => {
        // Force the correction flow's flow_runs insert to fail. Because the
        // dispatcher now runs inside executeIdempotent's transaction, the
        // aborted transaction must roll back every material write.
        await withBypass(() => db.execute(sql.raw(`
          create or replace function public.${correctionFlowGuard}_fn() returns trigger
          language plpgsql as $guard$
          begin
            if new.flow_id = '${correctionFlowId}'::uuid then
              raise exception 'forced correction flow routing failure';
            end if;
            return new;
          end
          $guard$;
        `)))
        await withOrgContext(org.orgId, () => postDocument(
          voidRollbackSourceId,
          {
            control: {
              ar: org.accounts.ar,
              ap: org.accounts.ap,
              bank: org.accounts.bank,
            },
          },
          { audit: { actorId, source: 'test' } },
        ))
        const source = await loadStoredDocument(org.orgId, voidRollbackSourceId)
        const user = {
          id: actorId,
          email: 'occ-correction-failure@scratch.test',
          name: 'OCC Correction Failure Controller',
          roles: [{ key: 'admin', name: 'Admin' }],
          orgId: org.orgId,
          envKind: 'production' as const,
          productionOrgId: org.orgId,
          isSuperAdmin: false,
          homeUserId: actorId,
          homeOrgId: org.orgId,
        }
        const attempt = await settle(withSimClock(org.date, () => withOrgContext(
          org.orgId,
          () => correctPostedDocument(
            {
              authz: {
                user,
                permissions: new Set(['*']),
                allowedSubsidiaryIds: null,
              },
              source: 'api',
              requestId: 'occ-application-correction-flow-failure',
              apiKeyId: null,
            },
            {
              documentId: voidRollbackSourceId,
              correction: {
                expectedUpdatedAt: source.updatedAt,
                amendmentReason: 'Correct duplicated vendor charge after flow failure',
                partyId: org.vendorId,
                documentDate: org.date,
                memo: 'flow failure must roll back',
                lines: [{ accountId: org.accounts.cogs, amount: '125' }],
              },
              idempotencyKey: 'occ-correction-flow-failure-api-0001',
            },
          ),
        )))
        assert.equal(attempt.status, 'rejected')

        const rolledBack = await withOrgContext(org.orgId, async () => (await db.execute<{
          sourceStatus: string
          links: number
          replacements: number
          claims: number
        }>(sql`
          select source.status as "sourceStatus",
                 (select count(*)::int from document_links
                   where org_id = ${org.orgId}
                     and to_document_id = ${voidRollbackSourceId}
                     and link_type = 'reverses') as links,
                 (select count(*)::int from documents
                   where org_id = ${org.orgId}
                     and custom->>'correctionOf' = ${voidRollbackSourceId}) as replacements,
                 (select count(*)::int from application_idempotency_keys
                   where org_id = ${org.orgId}
                     and actor_id = ${actorId}
                     and source = 'api'
                     and operation = 'documents.correct'
                     and idempotency_key = 'occ-correction-flow-failure-api-0001') as claims
            from documents source
           where source.org_id = ${org.orgId}
             and source.id = ${voidRollbackSourceId}
        `)).rows[0])
        assert.deepEqual(rolledBack, {
          sourceStatus: 'posted',
          links: 0,
          replacements: 0,
          claims: 0,
        })

        // Restore the transactional guard for the remaining correction tests.
        await withBypass(() => db.execute(sql.raw(`
          create or replace function public.${correctionFlowGuard}_fn() returns trigger
          language plpgsql as $guard$
          begin
            if new.flow_id = '${correctionFlowId}'::uuid and not exists (
              select 1
                from document_links link
               where link.org_id = new.org_id
                 and link.from_document_id = new.subject_id
                 and link.xmin::text::bigint = txid_current()
            ) then
              raise exception 'correction flow dispatched after correction transaction committed';
            end if;
            return new;
          end
          $guard$;
        `)))
      })

      await t.test('a failing void rolls the whole posted correction back atomically', async () => {
        // The UI route deliberately dispatches its deferred flow after the
        // surrounding transaction commits (it has no idempotent command
        // wrapper). The application correction assertions above own the
        // transaction guard; remove it here so this independent route
        // composition can continue to exercise its post-commit dispatch.
        await withBypass(() => db.execute(sql.raw(`
          drop trigger if exists ${correctionFlowGuard} on flow_runs
        `)))
        // A void claim that lands between the replacement draft and the void
        // request is exactly the window the removed compensating-delete
        // fallback could not reliably clean up. With the claim in place the
        // void request can never succeed, so the whole unit must roll back.
        await withOrgContext(org.orgId, async () => {
          await db.execute(sql`
            update documents
               set void_reason = 'claimed concurrently',
                   void_requested_at = now(),
                   void_requested_by = ${actorId},
                   void_reversal_date = ${org.date},
                   updated_by = ${actorId}
             where id = ${voidRollbackSourceId} and org_id = ${org.orgId}
          `)
        })

        // The UI route's composition: both writes inside one tenant
        // transaction, flows deferred until it commits.
        const runCorrectionCommand = () => withSimClock(org.date, () => withOrgContext(
          org.orgId,
          async () => {
            const outcome = await withOrgTransaction(org.orgId, async () => {
              const source = await loadStoredDocument(org.orgId, voidRollbackSourceId)
              const replacement = await createPostedCorrectionDraft(
                voidRollbackSourceId,
                {
                  expectedUpdatedAt: source.updatedAt,
                  amendmentReason: 'Correct duplicated vendor charge',
                  partyId: org.vendorId,
                  documentDate: org.date,
                  memo: 'atomic correction',
                  lines: [{ accountId: org.accounts.cogs, amount: '125' }],
                },
                editContext,
                { deferFlows: true },
              )
              const result = await requestDocumentVoid({
                documentId: voidRollbackSourceId,
                orgId: org.orgId,
                actorId,
                reason: 'Correct duplicated vendor charge',
                source: 'ui',
              })
              return { replacement, result }
            })
            await runPostedCorrectionDraftFlows(outcome.replacement.id, 'vendor_bill', {
              orgId: org.orgId,
              userId: actorId,
              source: 'posted_correction',
            })
            return outcome
          },
        ))

        const attempt = await settle(runCorrectionCommand())
        assert.ok(
          attempt.status === 'rejected'
            && attempt.reason instanceof DocumentVoidError
            && /already has a pending void request/.test(attempt.reason.message),
        )

        const lineage = await withOrgContext(org.orgId, async () => (await db.execute<{
          links: number
          replacements: number
        }>(sql`
          select
            (select count(*)::int from document_links
              where org_id = ${org.orgId}
                and to_document_id = ${voidRollbackSourceId}
                and link_type = 'reverses') as links,
            (select count(*)::int from documents
              where org_id = ${org.orgId}
                and custom->>'correctionOf' = ${voidRollbackSourceId}) as replacements
        `)).rows[0])
        assert.deepEqual(lineage, { links: 0, replacements: 0 })
        assert.equal((await loadStoredDocument(org.orgId, voidRollbackSourceId)).status, 'posted')

        // Fail-closed means recoverable: once the competing claim clears, the
        // same request succeeds end to end — no stuck correction edge.
        await withOrgContext(org.orgId, async () => {
          await db.execute(sql`
            update documents
               set void_reason = null,
                   void_requested_at = null,
                   void_requested_by = null,
                   void_reversal_date = null,
                   updated_by = ${actorId}
             where id = ${voidRollbackSourceId} and org_id = ${org.orgId}
          `)
        })
        const retry = await settle(runCorrectionCommand())
        assert.ok(retry.status === 'fulfilled' && retry.value.result.status === 'voided')

        const committed = await withOrgContext(org.orgId, async () => (await db.execute<{
          sourceStatus: string
          links: number
          replacementMemo: string | null
          runs: number
        }>(sql`
          select source.status as "sourceStatus",
                 (select count(*)::int from document_links l2
                   where l2.org_id = source.org_id
                     and l2.to_document_id = source.id
                     and l2.link_type = 'reverses') as links,
                 (select r.memo from document_links l3
                    join documents r on r.org_id = l3.org_id and r.id = l3.from_document_id
                   where l3.org_id = source.org_id
                     and l3.to_document_id = source.id
                     and l3.link_type = 'reverses') as "replacementMemo",
                 (select count(*)::int from flow_runs
                   where org_id = ${org.orgId}
                     and subject_id = (
                       select l4.from_document_id from document_links l4
                        where l4.org_id = source.org_id
                          and l4.to_document_id = source.id
                          and l4.link_type = 'reverses'
                     )) as runs
            from documents source
           where source.org_id = ${org.orgId} and source.id = ${voidRollbackSourceId}
        `)).rows[0])
        assert.deepEqual(committed, {
          sourceStatus: 'voided',
          links: 1,
          replacementMemo: 'atomic correction',
          runs: 1,
        })
      })
    } finally {
      await withBypass(async () => {
        await db.execute(sql.raw(`drop trigger if exists ${correctionFlowGuard} on flow_runs`))
        await db.execute(sql.raw(`drop function if exists public.${correctionFlowGuard}_fn()`))
      })
      await dropScratchOrg(org.orgId)
    }
  },
)
test('load and lock SQL preserve the exact revision token end to end', () => {
  assert.match(
    readFileSync(new URL('../../engine/src/document-revision.ts', import.meta.url), 'utf8'),
    /function documentRevisionSql[\s\S]*?at time zone 'UTC'[\s\S]*?HH24:MI:SS\.US/,
  )
  // Every load and every lock projects the exact canonical token: the list
  // read, loadDocument's row, loadDocumentEditCurrent's snapshot, the posted-
  // correction lock, and the edit lock.
  assert.equal(DOCUMENTS_SOURCE.match(/documentRevisionSql\(sql\.raw\('(d\.)?updated_at'\)\)/g)?.length, 5)
  assert.match(DOCUMENTS_SOURCE, /select kind, status,[\s\S]*?documentRevisionSql[\s\S]*?for update/)
  // Draft minting is attributable: the insert stamps the creating user, and
  // on_create flows settle before the writer ever receives a token.
  assert.match(
    DOCUMENTS_SOURCE,
    /createDocumentDraft[\s\S]*?createdBy: userId,[\s\S]*?runRecordFlows\(\{ kind: 'on_create'/,
  )
  assert.match(
    DOCUMENTS_SOURCE,
    /updated_at = greatest\([\s\S]*?clock_timestamp\(\)[\s\S]*?interval '1 microsecond'/,
  )
  assert.doesNotMatch(
    DOCUMENTS_SOURCE.slice(
      DOCUMENTS_SOURCE.indexOf('export function requireDocumentEditRevision'),
      DOCUMENTS_SOURCE.indexOf('export function assertNoExistingDocumentCorrection'),
    ),
    /new Date|getTime\(/,
  )
})

type VersionedLockRow = { status: string; updatedAt: unknown }

/** Drive runDocumentVersionedTransaction against a stubbed lock + mutation. */
function versionedRun(lockedRow: VersionedLockRow | null, expectedRevision: string): {
  run: Promise<number>
  mutations: () => number
} {
  let writes = 0
  const run = runDocumentVersionedTransaction<{ handle: number }, VersionedLockRow, number>({
    expectedRevision,
    transaction: async (work) => work({ handle: 1 }),
    lock: async () => lockedRow,
    mutate: async () => {
      writes += 1
      return writes
    },
  })
  return { run, mutations: () => writes }
}

test('the locked revision must itself be an exact persisted token before any write', async () => {
  const exact = '2026-08-24T12:00:00.123001Z'
  // A lock projection that regresses away documentRevisionSql hands back
  // whatever the driver or PostgreSQL defaults produce — a mapped Date, a
  // second-granularity timestamp, default text rendering, an empty value.
  // String equality between two equally lossy values would authorize a write
  // against a revision this system never issued, so each must fail closed
  // before any comparison runs — even when the caller echoes the same lossy
  // value back verbatim.
  for (const [lossy, echoed] of [
    [new Date('2026-08-24T12:00:00.123001Z'), exact],
    ['2026-08-24T12:00:00Z', '2026-08-24T12:00:00Z'],
    ['2026-08-24 12:00:00.123001+00', '2026-08-24 12:00:00.123001+00'],
    ['', ''],
    [null, exact],
  ] as const) {
    const attempt = versionedRun({ status: 'draft', updatedAt: lossy }, echoed)
    await assert.rejects(attempt.run, /exact persisted revision/)
    assert.equal(attempt.mutations(), 0, `no mutation may follow a ${typeof lossy} lock revision`)
  }

  const matched = versionedRun({ status: 'draft', updatedAt: exact }, exact)
  assert.equal(await matched.run, 1)
  assert.equal(matched.mutations(), 1)

  await assert.rejects(
    versionedRun({ status: 'draft', updatedAt: '2026-08-24T12:00:00.999999Z' }, exact).run,
    isConflict,
  )
  await assert.rejects(
    versionedRun(null, exact).run,
    (e: unknown) => e instanceof DocumentEditError && e.status === 404,
  )
})

test('reversal link evidence carries the full mandatory audit contract', () => {
  const before = new Date('2026-08-24T00:00:00Z')
  const link = buildReversalLinkEvidence({
    fromDocumentId: 'replacement-1',
    toDocumentId: 'source-1',
    reason: '  mis-keyed vendor on the original bill  ',
    requestedBy: 'user-1',
  })
  assert.equal(link.linkType, 'reverses')
  assert.equal(link.fromDocumentId, 'replacement-1')
  assert.equal(link.toDocumentId, 'source-1')
  assert.equal(link.reason, 'mis-keyed vendor on the original bill')
  assert.equal(link.requestedBy, 'user-1')
  assert.ok(link.requestedAt instanceof Date && link.requestedAt >= before)
})

test('a reversal link cannot be constructed without the evidence the database mandates', () => {
  // The document_links_reversal_evidence CHECK refuses any 'reverses' edge
  // whose btrimmed reason falls outside 8..500 or whose requester is null —
  // so this seam must reject exactly those inputs instead of letting the
  // insert abort the whole correction transaction with a constraint error.
  const base = { fromDocumentId: 'r1', toDocumentId: 's1' }
  for (const bad of ['short', '       ', '', 'x'.repeat(501), undefined, null]) {
    assert.throws(
      () => buildReversalLinkEvidence({ ...base, reason: bad as string | null | undefined, requestedBy: 'user-1' }),
      (e: unknown) =>
        e instanceof DocumentEditError && e.status === 422 && /8 and 500/.test(e.message),
      `reason ${JSON.stringify(bad)} must be rejected`,
    )
  }
  assert.equal(validateCorrectionReason(`  ${'y'.repeat(500)}  `).length, 500)

  assert.throws(
    () => buildReversalLinkEvidence({ ...base, reason: 'a perfectly valid reason', requestedBy: '' }),
    (e: unknown) => e instanceof DocumentEditError && e.status === 422 && /attributable requester/.test(e.message),
  )
  assert.throws(
    () => buildReversalLinkEvidence({ ...base, fromDocumentId: '', toDocumentId: 's1', reason: 'a perfectly valid reason', requestedBy: 'u1' }),
    (e: unknown) => e instanceof DocumentEditError && e.status === 422 && /both the replacement and the corrected/.test(e.message),
  )
})

test("the posted-correction path records its reverses edge through the mandatory-evidence builder", () => {
  // Regression pin (source-level): createPostedCorrectionDraft used to insert
  // a bare 'reverses' edge — no reason, requester, or timestamp — which the
  // database's document_links_reversal_evidence CHECK now rejects outright.
  // The only 'reverses' literal in web/lib/documents.ts must live inside the
  // evidence builder, and the correction transaction must compose it.
  const source = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8')
  assert.match(source, /\.\.\.buildReversalLinkEvidence\(/)
  // Inside the correction transaction itself, the edge must be composed from
  // the builder — no hand-rolled linkType line may exist there.
  const fn = source.match(/export async function createPostedCorrectionDraft[\s\S]*?\n\}/)
  assert.ok(fn, 'createPostedCorrectionDraft found')
  assert.doesNotMatch(fn[0], /linkType:/)
})

test('the UI correction route commits the replacement and its void as one atomic unit', () => {
  // Regression pin (source-level): POST used to create the replacement, then
  // request the void outside any transaction, and paper over failures with a
  // best-effort deleteDocument whose errors were swallowed — so a failed void
  // (and a failed cleanup) left a `reverses` edge against a still-posted
  // source, permanently bricking further corrections with a 409 conflict.
  const routeSource = readFileSync(
    new URL('../app/api/documents/[id]/correct/route.ts', import.meta.url),
    'utf8',
  )
  const handler = routeSource.slice(routeSource.indexOf('export async function POST'))
  const atomic = handler.indexOf('withOrgTransaction(')
  const create = handler.indexOf('createPostedCorrectionDraft(', atomic)
  const defer = handler.indexOf('{ deferFlows: true }', create)
  const voidCall = handler.indexOf('requestDocumentVoid(', defer)
  const dispatch = handler.indexOf('runPostedCorrectionDraftFlows(', voidCall)
  assert.ok(atomic >= 0 && create > atomic && defer > create && voidCall > defer)
  // Flow dispatch happens only after the atomic unit resolves.
  assert.ok(dispatch > voidCall)
  // Neither write may be separated from the wrapper by an early return.
  assert.doesNotMatch(handler.slice(atomic, voidCall), /NextResponse\.json/)
  // The swallowed compensating delete must stay dead.
  assert.doesNotMatch(handler, /deleteDocument/)
  assert.doesNotMatch(handler, /\.catch\(\(\) => \{\}\)/)
})

test('provider failure during API document create leaves no document or dependent rows', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
  const provider = createServer(async (req, res) => {
    await consumeRequest(req)
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'provider offline' }))
  })
  try {
    const taxCodeId = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into tax_codes
          (id, org_id, code, name, recoverable_percent, collected_account_id, paid_account_id, is_active)
        values (${taxCodeId}, ${org.orgId}, 'CREATE-EXT', 'Create external tax', '100',
                ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true)`)
      await db.execute(sql`
        insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from)
        values (${randomUUID()}, ${org.orgId}, ${taxCodeId}, '13', ${org.date})`)
    })
    const origin = await listenProvider(provider)
    await withBypass(() => saveTaxRateProviderConfig(
      org.orgId,
      { provider: 'custom_http', isEnabled: true, preferProvider: true, settings: { quoteUrl: `${origin}/quote` } },
      actorId,
    ))

    const result = await createRecord(
      { id: actorId, orgId: org.orgId, roles: [] } as never,
      {
        key: 'bills',
        table: 'documents',
        searchColumn: 'document_number',
        readPermission: 'ap.read',
        writePermission: 'ap.create',
        operations: ['list', 'get', 'create', 'update', 'delete'],
        writer: { kind: 'document', docKind: 'vendor_bill' },
        dynamic: false,
        documentKinds: ['vendor_bill'],
      } as never,
      [],
      {
        partyId: org.vendorId,
        lines: [{ accountId: org.accounts.cogs, amount: '100.0000', taxCodeId }],
      },
      { source: 'api' },
    )
    assert.equal(result.status, 422)
    const counts = await withBypass(() => db.execute<{
      documents: string
      lines: string
      quotes: string
      journals: string
      effects: string
      audits: string
    }>(sql`
      select
        (select count(*) from documents where org_id = ${org.orgId} and document_number like 'BILL-%')::text as documents,
        (select count(*) from document_lines where org_id = ${org.orgId})::text as lines,
        (select count(*) from tax_rate_quotes where org_id = ${org.orgId})::text as quotes,
        (select count(*) from journal_entries where org_id = ${org.orgId})::text as journals,
        (select count(*) from posting_effects where org_id = ${org.orgId})::text as effects,
        (select count(*) from audit_log where org_id = ${org.orgId} and table_name = 'documents')::text as audits`))
    assert.deepEqual(counts.rows[0], {
      documents: '0',
      lines: '0',
      quotes: '0',
      journals: '0',
      effects: '0',
      audits: '0',
    })
  } finally {
    await closeProvider(provider)
    await withBypass(() => dropScratchOrg(org.orgId))
  }
})
