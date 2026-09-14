import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITIES, REPORT_ENTITY_MAP } from './entities'
import {
  compileCustomQuery,
  customQueryReferencesBook,
  parseDenominationCounts,
  reportBaseCurrencyPin,
  reportBookPin,
  reportTxnCurrencyPin,
  resolveDenominations,
} from './custom-query'
import { runCustomQuery } from './run'
import { validateCustomQuery } from './validate'

const ORG = '00000000-0000-4000-8000-000000000001'
const PRIMARY = '00000000-0000-4000-8000-000000000011'
const TAX = '00000000-0000-4000-8000-000000000022'
const SUB = '00000000-0000-4000-8000-000000000033'

test('GL entities declare a book boundary; transaction sources stay book-agnostic', () => {
  assert.equal(REPORT_ENTITY_MAP.ledger_lines!.bookScope?.column, 'je.book_id')
  assert.equal(REPORT_ENTITY_MAP.journal_entries!.bookScope?.column, 'je.book_id')
  assert.equal(REPORT_ENTITY_MAP.documents!.bookScope, undefined)
  assert.equal(REPORT_ENTITY_MAP.transaction_lines!.bookScope, undefined)
  for (const key of ['ledger_lines', 'journal_entries'] as const) {
    const columns = REPORT_ENTITY_MAP[key]!.columns.map((c) => c.key)
    for (const bookKey of ['book', 'book_code', 'book_id']) assert.ok(columns.includes(bookKey), `${key} exposes ${bookKey}`)
  }
})

test('every book and subsidiary join is pinned to the base organization', () => {
  for (const key of ['ledger_lines', 'journal_entries'] as const) {
    const entity = REPORT_ENTITY_MAP[key]!
    assert.match(entity.from, /JOIN accounting_books b ON b\.id = je\.book_id AND b\.org_id = je\.org_id/)
  }
  assert.match(
    REPORT_ENTITY_MAP.ledger_lines!.from,
    /JOIN subsidiaries sub ON sub\.id = jl\.subsidiary_id AND sub\.org_id = jl\.org_id/,
  )
})

test('denomination markers always name their dimension column', () => {
  for (const entity of REPORT_ENTITIES) {
    for (const column of entity.columns) {
      if (column.txnCurrency) {
        assert.ok(entity.currencyColumn, `${entity.key}.${column.key} needs currencyColumn`)
        assert.ok(entity.columns.some((c) => c.key === entity.currencyColumn), `${entity.key} exposes ${entity.currencyColumn}`)
      }
      if (column.baseMoney) {
        assert.ok(entity.baseCurrencyColumn, `${entity.key}.${column.key} needs baseCurrencyColumn`)
        assert.ok(entity.columns.some((c) => c.key === entity.baseCurrencyColumn), `${entity.key} exposes ${entity.baseCurrencyColumn}`)
        assert.notEqual(entity.baseCurrencyColumn, 'currency', `${entity.key} base is never the txn currency`)
      }
    }
  }
  assert.equal(REPORT_ENTITY_MAP.ledger_lines!.baseCurrencyColumn, 'base_currency')
})

test('book allowlist ANDs a book predicate without touching user filters', () => {
  const entity = REPORT_ENTITY_MAP.ledger_lines!
  const q = {
    entity: 'ledger_lines',
    mode: 'rows',
    columns: ['posting_date', 'amount'],
    filters: { combinator: 'and', rules: [{ field: 'entry_status', op: 'eq', value: 'posted' }] },
    limit: 10,
  }
  const compiled = compileCustomQuery(entity, q, ORG, { allowedBookIds: [PRIMARY] })
  assert.match(compiled.text, /jl\.org_id = \$1/)
  assert.match(compiled.text, /je\.book_id = ANY\(\$2::uuid\[\]\)/)
  assert.match(compiled.text, /je\.status = /)
  assert.deepEqual(compiled.values.slice(0, 2), [ORG, [PRIMARY]])
})

test('empty book allowlist matches nothing; absent allowlist leaves the basis alone', () => {
  const entity = REPORT_ENTITY_MAP.ledger_lines!
  const q = { entity: 'ledger_lines', mode: 'rows', columns: ['amount'], limit: 10 }
  assert.match(compileCustomQuery(entity, q, ORG, { allowedBookIds: [] }).text, /FALSE/)
  assert.doesNotMatch(compileCustomQuery(entity, q, ORG, {}).text, /je\.book_id = ANY/)
  assert.doesNotMatch(compileCustomQuery(entity, q, ORG, { allowedBookIds: null }).text, /je\.book_id = ANY/)
})

test('book allowlist is ignored by book-independent entities', () => {
  const entity = REPORT_ENTITY_MAP.documents!
  const q = { entity: 'documents', mode: 'rows', columns: ['document_number'], limit: 10 }
  assert.doesNotMatch(compileCustomQuery(entity, q, ORG, { allowedBookIds: [PRIMARY] }).text, /je\.book_id = ANY/)
})

test('lifting the book clamp never lifts the org or subsidiary fences', () => {
  const entity = REPORT_ENTITY_MAP.ledger_lines!
  const q = {
    entity: 'ledger_lines',
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'book' }],
    measures: [{ fn: 'sum', column: 'amount' }],
  }
  const compiled = compileCustomQuery(entity, q, ORG, {
    allowedSubsidiaryIds: [SUB],
    allowedBookIds: null,
  })
  assert.match(compiled.text, /jl\.org_id = \$1/)
  assert.match(compiled.text, /jl\.subsidiary_id = ANY\(\$2::uuid\[\]\)/)
  assert.doesNotMatch(compiled.text, /book_id = ANY/)
})

test('book references lift the default; display-only book columns do not', () => {
  const base = {
    entity: 'ledger_lines',
    mode: 'rows' as const,
    columns: ['posting_date'],
    filters: null,
    limit: 10,
  }
  assert.equal(customQueryReferencesBook(base), false)
  assert.equal(
    customQueryReferencesBook({
      ...base,
      columns: ['posting_date', 'book', 'book_code'],
    }),
    false,
    'selecting book labels for display keeps the primary default',
  )
  assert.equal(
    customQueryReferencesBook({
      ...base,
      filters: { combinator: 'and', rules: [{ field: 'book_id', op: 'eq', value: TAX }] },
    }),
    true,
  )
  assert.equal(
    customQueryReferencesBook({
      entity: 'ledger_lines',
      mode: 'summarize' as const,
      columns: [],
      breakouts: [{ column: 'book' }],
      measures: [{ fn: 'sum', column: 'amount' }],
    }),
    true,
  )
  assert.equal(
    customQueryReferencesBook({ ...base, groupBy: 'book_code' }),
    true,
  )
})

test('pins stay conservative across books, bases, and currencies', () => {
  const ledger = REPORT_ENTITY_MAP.ledger_lines!
  const q = (filters: unknown) => ({
    entity: 'ledger_lines', mode: 'summarize' as const, columns: [],
    breakouts: [{ column: 'account_number' }], measures: [{ fn: 'sum' as const, column: 'amount' }],
    filters: filters as never,
  })
  assert.equal(reportBookPin(ledger, q({ combinator: 'and', rules: [{ field: 'book_id', op: 'eq', value: TAX }] })), TAX)
  assert.equal(reportBookPin(ledger, q({ combinator: 'and', rules: [{ field: 'book_code', op: 'eq', value: 'TAX' }] })), 'TAX')
  // Display names are not schema-unique: they scope rows but never certify a basis.
  assert.equal(reportBookPin(ledger, q({ combinator: 'and', rules: [{ field: 'book', op: 'eq', value: 'Tax book' }] })), null)
  assert.equal(
    reportBookPin(ledger, q({
      combinator: 'or',
      rules: [
        { field: 'book_id', op: 'eq', value: TAX },
        { field: 'book_id', op: 'eq', value: PRIMARY },
      ],
    })),
    null,
  )
  assert.equal(
    reportBaseCurrencyPin(ledger, q({ combinator: 'and', rules: [{ field: 'base_currency', op: 'eq', value: 'CAD' }] })),
    'CAD',
  )
  assert.equal(
    reportTxnCurrencyPin(ledger, q({
      combinator: 'and',
      rules: [{
        combinator: 'and',
        not: true,
        rules: [{ field: 'currency', op: 'eq', value: 'USD' }],
      }],
    })),
    null,
  )
})

test('inline census covers only still-open money dimensions', () => {
  const ledger = REPORT_ENTITY_MAP.ledger_lines!
  const plan = {
    entity: 'ledger_lines',
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'account_number' }],
    measures: [{ fn: 'sum', column: 'amount' }],
  }
  // Primary clamp certifies the book; the base stays open across subsidiaries.
  const clamped = compileCustomQuery(ledger, plan, ORG, { allowedBookIds: [PRIMARY] })
  assert.ok(clamped.hasDenominationCensus, 'base census still needed')
  assert.match(clamped.text, /COUNT\(DISTINCT sub\.base_currency\) AS "base_n"/)
  assert.doesNotMatch(clamped.text, /book_n/)
  assert.doesNotMatch(clamped.text, /txn_n/)
  // A single-subsidiary scope certifies the base too: no probe at all.
  const scoped = compileCustomQuery(ledger, plan, ORG, { allowedBookIds: [PRIMARY], allowedSubsidiaryIds: [SUB] })
  assert.equal(scoped.hasDenominationCensus, false)
  assert.equal(scoped.bookSingleBasis, true)
  assert.equal(scoped.baseSingleSubsidiary, true)
  // A static base pin also skips the census.
  const pinned = compileCustomQuery(ledger, {
    ...plan,
    filters: { combinator: 'and', rules: [{ field: 'base_currency', op: 'eq', value: 'CAD' }] },
  }, ORG, { allowedBookIds: [PRIMARY] })
  assert.equal(pinned.baseCurrencyPinned, 'CAD')
  assert.equal(pinned.hasDenominationCensus, false)
  // Transaction lines probe the header currency, never books or bases.
  const lines = REPORT_ENTITY_MAP.transaction_lines!
  const lineProbe = compileCustomQuery(lines, {
    entity: 'transaction_lines',
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'kind' }],
    measures: [{ fn: 'sum', column: 'amount' }],
  }, ORG, {})
  assert.match(lineProbe.text, /COUNT\(DISTINCT d\.currency\) AS "txn_n"/)
  assert.doesNotMatch(lineProbe.text, /base_n|book_n/)
})

test('unparseable probe counts fail closed', () => {
  assert.deepEqual(parseDenominationCounts(null), {})
  assert.deepEqual(parseDenominationCounts({ __txn_n: 'nope', __txn_v: 'USD' }), {
    txn: { distinct: Number.MAX_SAFE_INTEGER, sample: 'USD' },
  })
  const ledger = REPORT_ENTITY_MAP.ledger_lines!
  assert.throws(
    () => resolveDenominations(ledger, {
      breakouts: [{ column: 'account_number' }],
      measures: [{ fn: 'sum', column: 'amount' }],
      bookSingleBasis: true,
    }, parseDenominationCounts({ __base_n: 'bogus' })),
    /functional currencies/,
  )
})

// A single statement returns both result values and its denomination census.
const clientFor = (probeRow: Record<string, unknown> | null, mainRows: Record<string, unknown>[]) => ({
  query: async (text: string) => ({
    rows: mainRows.map((row) => ({ ...row, __book_group_n: '1', ...(text.includes('WITH __denom AS') ? Object.fromEntries(Object.entries(probeRow ?? {}).map(([key, value]) => ['__' + key, value])) : {}) })),
  }),
})

test('ungrouped mixed txn sums are refused; single-currency runs proceed untouched', async () => {
  const plan = {
    entity: 'documents',
    mode: 'summarize',
    columns: [],
    breakouts: [],
    measures: [{ fn: 'sum', column: 'total' }],
  }
  await assert.rejects(
    runCustomQuery(
      clientFor({ txn_n: '2', txn_v: 'CAD' }, [{ m0: '300' }]),
      plan,
      { orgId: ORG, entityMap: REPORT_ENTITY_MAP },
    ),
    /mix transaction currencies/,
  )
  const single = await runCustomQuery(
    clientFor({ txn_n: '1', txn_v: 'USD' }, [{ m0: '100' }]),
    plan,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP },
  )
  assert.deepEqual(single.groups[0]!.rows, [['100']])
  assert.ok(single.summary.some((s) => s.label.startsWith('Total')), 'legitimate one-currency total stays')
})

for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
  test(`txn ${fn} shares the mixed-currency gate`, async () => {
      const plan = {
      entity: 'documents',
      mode: 'summarize',
      columns: [],
      breakouts: [],
      measures: [{ fn, column: 'total' }],
    }
    await assert.rejects(
      runCustomQuery(
        clientFor({ txn_n: '3', txn_v: 'CAD' }, [{ m0: '300' }]),
        plan,
        { orgId: ORG, entityMap: REPORT_ENTITY_MAP },
      ),
      /mix transaction currencies/,
    )
    const single = await runCustomQuery(
      clientFor({ txn_n: '1', txn_v: 'CAD' }, [{ m0: '300' }]),
      plan,
      { orgId: ORG, entityMap: REPORT_ENTITY_MAP },
    )
    assert.equal(single.groups[0]!.rows.length, 1)
  })
}

test('base blends need a base partition; per-base rows stay with no mixed card', async () => {
  const ungrouped = {
    entity: 'ledger_lines',
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'account_number' }],
    measures: [{ fn: 'sum', column: 'amount' }],
  }
  await assert.rejects(
    runCustomQuery(
      clientFor({ base_n: '2', base_v: 'CAD' }, [{ d0: '4000', m0: '-200' }]),
      ungrouped,
      { orgId: ORG, entityMap: REPORT_ENTITY_MAP, allowedBookIds: [PRIMARY] },
    ),
    /functional currencies/,
  )
  const grouped = {
    ...ungrouped,
    breakouts: [{ column: 'base_currency' }, { column: 'account_number' }],
  }
  const split = await runCustomQuery(
    clientFor({ base_n: '2', base_v: 'CAD' }, [
      { d0: 'CAD', d1: '4000', m0: '-100' },
      { d0: 'USD', d1: '4000', m0: '-100' },
    ]),
    grouped,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP, allowedBookIds: [PRIMARY] },
  )
  assert.equal(split.groups[0]!.rows.length, 2)
  assert.deepEqual(split.summary.map((s) => s.label), ['Groups'], 'no mixed-base Total card')
  const oneBase = await runCustomQuery(
    clientFor({ base_n: '1', base_v: 'CAD' }, [{ d0: '4000', m0: '-100' }]),
    ungrouped,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP, allowedBookIds: [PRIMARY] },
  )
  assert.ok(oneBase.summary.some((s) => s.label.startsWith('Total')), 'single-base total stays')
})

test('book blends need a book partition; per-book rows stay with no mixed card', async () => {
  const ungrouped = {
    entity: 'ledger_lines',
    mode: 'summarize',
    columns: [],
    breakouts: [{ column: 'account_number' }],
    measures: [{ fn: 'sum', column: 'amount' }],
  }
  const scope = { orgId: ORG, entityMap: REPORT_ENTITY_MAP, allowedBookIds: null as null }
  await assert.rejects(
    runCustomQuery(
      clientFor({ base_n: '1', base_v: 'CAD', book_n: '2', book_v: PRIMARY }, [{ d0: '4000', m0: '-350' }]),
      ungrouped,
      scope,
    ),
    /accounting books/,
  )
  const grouped = { ...ungrouped, breakouts: [{ column: 'book' }] }
  const split = await runCustomQuery(
    clientFor({ base_n: '1', base_v: 'CAD', book_n: '2', book_v: PRIMARY }, [
      { d0: 'Primary', m0: '-100' },
      { d0: 'Tax book', m0: '-250' },
    ]),
    grouped,
    scope,
  )
  assert.deepEqual(split.groups[0]!.rows, [['Primary', '-100'], ['Tax book', '-250']])
  assert.deepEqual(split.summary.map((s) => s.label), ['Groups'], 'no fused cross-book Total card')
  await assert.rejects(
    runCustomQuery(
      clientFor({ base_n: '1', base_v: 'CAD', book_n: '2', book_v: PRIMARY }, [
        { d0: 'Primary', m0: '-100' },
        { d0: 'Tax book', m0: '-250' },
      ]),
      {
        ...grouped,
        groupBy: 'book',
        totals: { grand: true },
      },
      scope,
    ),
    /cannot combine accounting books/,
  )
  // A positively pinned book totals honestly.
  const pinned = await runCustomQuery(
    clientFor({ base_n: '1', base_v: 'CAD' }, [{ d0: '4000', m0: '-250' }]),
    {
      ...ungrouped,
      filters: { combinator: 'and', rules: [{ field: 'book_id', op: 'eq', value: TAX }] },
      groupBy: null,
      totals: { grand: true },
    },
    scope,
  )
  assert.ok(pinned.summary.some((s) => s.label.startsWith('Total')))
})

test('rows-mode money summary carries no monetary totals', async () => {
  const result = await runCustomQuery(
    clientFor(null, [{ posting_date: '2026-07-15', amount: '100.0000' }]),
    { entity: 'ledger_lines', mode: 'rows', columns: ['posting_date', 'amount'] },
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP },
  )
  assert.deepEqual(result.summary.map((s) => s.label), ['Rows', 'Source'])
})

test('saved explicit book filters survive validation verbatim', () => {
  const filters = {
    combinator: 'and',
    rules: [
      { field: 'entry_status', op: 'eq', value: 'posted' },
      { field: 'book_id', op: 'eq', value: TAX },
    ],
  }
  const sanitized = validateCustomQuery({
    entity: 'ledger_lines',
    mode: 'rows',
    columns: ['posting_date', 'amount', 'book'],
    filters,
    limit: 50,
  })
  assert.deepEqual(sanitized.filters, filters)
})


test('missing census refuses nonempty results; empty results stay empty', async () => {
  const plan = { entity: 'documents', mode: 'summarize', columns: [], measures: [{ fn: 'sum', column: 'total' }] }
  await assert.rejects(runCustomQuery({ query: async () => ({ rows: [{ m0: '300' }] }) }, plan,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP }), /invalid denomination evidence/)
  const empty = await runCustomQuery({ query: async () => ({ rows: [] }) }, plan,
    { orgId: ORG, entityMap: REPORT_ENTITY_MAP })
  assert.equal(empty.rowCount, 0)
})
