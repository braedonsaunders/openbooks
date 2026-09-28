import assert from 'node:assert/strict'
import test from 'node:test'
import { REPORT_ENTITY_MAP, type ReportEntity } from './entities'
import { compileCustomQuery } from './custom-query'
import { runCustomQuery } from './run'

// SaaS normalization census properties: every SaaS money aggregate and every
// governed SaaS rows read executes the same-snapshot normalization census and
// fails closed through one shared classifier — unsupported versions by name
// first, then coherent all-null legacy, mixed/partial triples, multiple
// distinct versions, and missing/malformed/mismatched evidence. Coherent v1
// continues; pins, breakouts, and subsidiary scopes never suppress the
// probes. The remedy is always the Company Setup → SaaS Metrics request +
// distinct-approval workflow.

const ORG = '00000000-0000-4000-8000-000000000001'
const SUB = '00000000-0000-4000-8000-000000000033'

const REMEDY = /normalization request.*Company Setup.*SaaS Metrics.*different authorized approver/

const summarizePlan = (overrides: Record<string, unknown> = {}) => ({
  entity: 'saas_metrics_facts',
  mode: 'summarize',
  columns: [],
  breakouts: [{ column: 'month' }],
  measures: [{ fn: 'sum', column: 'new_mrr' }],
  ...overrides,
})

const rowsPlan = (overrides: Record<string, unknown> = {}) => ({
  entity: 'saas_metrics_facts',
  mode: 'rows',
  columns: ['month', 'new_mrr'],
  ...overrides,
})

const norm = (overrides: Record<string, unknown> = {}) => ({
  __norm_total: '2',
  __norm_legacy_n: '0',
  __norm_v1_n: '2',
  __norm_ver_n: '1',
  __norm_ver_v: 'v1',
  __norm_badver_n: '0',
  __norm_badver_v: null,
  __norm_ev_bad_n: '0',
  ...overrides,
})

const base = (overrides: Record<string, unknown> = {}) => ({
  __base_n: '1',
  __base_v: 'USD',
  ...overrides,
})

// A counting mock client: proves the one-statement rule by counting queries.
const countingClient = (dbRows: Record<string, unknown>[]) => {
  let calls = 0
  return {
    calls: () => calls,
    client: {
      query: async () => {
        calls += 1
        return { rows: dbRows.map((row) => ({ ...row })) }
      },
    },
  }
}

const opts = (entityMap: Record<string, ReportEntity> = REPORT_ENTITY_MAP, extra: Record<string, unknown> = {}) => ({
  orgId: ORG,
  entityMap,
  ...extra,
})

test('unsupported versions refuse by name before currency mixes are diagnosed', async () => {
  const probe = countingClient([{ d0: '2026-01-01', m0: '100', ...base({ __base_n: '2', __base_v: 'CAD' }), ...norm({ __norm_badver_n: '1', __norm_badver_v: 'v99' }) }])
  await assert.rejects(
    runCustomQuery(probe.client, summarizePlan(), opts()),
    /unsupported denomination version \(v99\).*normalization request/,
  )
  assert.equal(probe.calls(), 1)
})

test('coherent all-null legacy refuses with the normalization remedy', async () => {
  const probe = countingClient([{
    d0: '2026-01-01',
    m0: '100',
    ...base(),
    ...norm({ __norm_legacy_n: '2', __norm_v1_n: '0', __norm_ver_n: '0', __norm_ver_v: null }),
  }])
  await assert.rejects(
    runCustomQuery(probe.client, summarizePlan(), opts()),
    /legacy unnormalized denomination/,
  )
  await assert.rejects(runCustomQuery(probe.client, summarizePlan(), opts()), REMEDY)
})

test('mixed and partial triples refuse instead of certifying singularity', async () => {
  const mixed = countingClient([{
    d0: '2026-01-01', m0: '100', ...base(),
    ...norm({ __norm_legacy_n: '1', __norm_v1_n: '1' }),
  }])
  await assert.rejects(runCustomQuery(mixed.client, summarizePlan(), opts()), /mix legacy/)
  // Incomplete triple: currency and version present, evidence absent — not legacy, not v1.
  const partial = countingClient([{
    d0: '2026-01-01', m0: '100', ...base(),
    ...norm({ __norm_total: '1', __norm_legacy_n: '0', __norm_v1_n: '0' }),
  }])
  await assert.rejects(runCustomQuery(partial.client, summarizePlan(), opts()), /incomplete denomination/)
})

test('multiple distinct supported versions refuse without an unsupported one', async () => {
  const entity: ReportEntity = {
    ...REPORT_ENTITY_MAP.saas_metrics_facts!,
    key: 'saas_version_probe',
    normalization: {
      ...REPORT_ENTITY_MAP.saas_metrics_facts!.normalization!,
      supportedVersions: ['v1', 'v2'],
    },
  }
  const probe = countingClient([{
    d0: '2026-01-01', m0: '100', ...base(),
    ...norm({ __norm_ver_n: '2', __norm_ver_v: 'v1', __norm_badver_n: '0' }),
  }])
  await assert.rejects(
    runCustomQuery(probe.client, { ...summarizePlan(), entity: 'saas_version_probe' }, opts({ ...REPORT_ENTITY_MAP, saas_version_probe: entity })),
    /mix denomination versions/,
  )
})

test('present-but-malformed evidence is evidence failure, never legacy', async () => {
  const probe = countingClient([{
    d0: '2026-01-01', m0: '100', ...base(),
    ...norm({ __norm_ev_bad_n: '1' }),
  }])
  await assert.rejects(runCustomQuery(probe.client, summarizePlan(), opts()), /evidence.*missing, malformed, or does not match/)
})

test('evidence hashes that disagree with row hashes refuse with the distinct-approval remedy', async () => {
  const probe = countingClient([{
    d0: '2026-01-01', m0: '100', ...base(),
    ...norm({ __norm_total: '3', __norm_v1_n: '3', __norm_ev_bad_n: '2' }),
  }])
  await assert.rejects(runCustomQuery(probe.client, summarizePlan(), opts()), REMEDY)
})

test('coherent v1 runs untouched with honest totals', async () => {
  const probe = countingClient([{ d0: '2026-01-01', m0: '100', ...base(), ...norm() }])
  const result = await runCustomQuery(probe.client, summarizePlan(), opts())
  assert.equal(result.groups[0]!.rows.length, 1)
  assert.ok(result.summary.some((s) => s.label.startsWith('Total')), 'single-currency v1 total stays')
})

test('multi-currency blends refuse with reporting-currency nouns', async () => {
  const probe = countingClient([{ d0: '2026-01-01', m0: '300', ...base({ __base_n: '2', __base_v: 'CAD' }), ...norm() }])
  await assert.rejects(
    runCustomQuery(probe.client, summarizePlan(), opts()),
    /mix reporting currencies.*group by Reporting currency/,
  )
})

test('partitioned multi-currency flows per currency; combining totals and pins never bypass truth', async () => {
  const partitioned = {
    ...summarizePlan(),
    breakouts: [{ column: 'reporting_currency' }, { column: 'month' }],
  }
  const split = countingClient([
    { d0: 'CAD', d1: '2026-01-01', m0: '100', ...base({ __base_n: '2', __base_v: 'CAD' }), ...norm() },
    { d0: 'USD', d1: '2026-01-01', m0: '200', ...base({ __base_n: '2', __base_v: 'CAD' }), ...norm() },
  ])
  const result = await runCustomQuery(split.client, partitioned, opts())
  assert.equal(result.groups[0]!.rows.length, 2)
  await assert.rejects(
    runCustomQuery(split.client, { ...partitioned, groupBy: 'reporting_currency', totals: { grand: true } }, opts()),
    /cannot combine reporting currencies/,
  )
  // A reporting-currency pin still faces the normalization census.
  const pinned = countingClient([{
    d0: '2026-01-01', m0: '100',
    ...norm({ __norm_legacy_n: '1', __norm_v1_n: '0', __norm_total: '1', __norm_ver_n: '0', __norm_ver_v: null }),
  }])
  await assert.rejects(
    runCustomQuery(
      pinned.client,
      summarizePlan({ filters: { combinator: 'and', rules: [{ field: 'reporting_currency', op: 'eq', value: 'USD' }] } }),
      opts(),
    ),
    /legacy unnormalized denomination/,
  )
})

test('valid v1 rows pass with every hidden probe stripped', async () => {
  const probe = countingClient([{
    month: '2026-01-01',
    new_mrr: '100.0000',
    __page_present: 1,
    __nc_cur: 'USD',
    __nc_ver: 'v1',
    __nc_ev: {},
    __nc_ev_ok: true,
    __nc_evh: 'a',
    __nc_rowh: 'a',
    ...norm({ __norm_total: '1', __norm_v1_n: '1' }),
  }])
  const result = await runCustomQuery(probe.client, rowsPlan(), opts())
  assert.equal(result.rowCount, 1)
  assert.deepEqual(result.groups[0]!.rows, [['2026-01-01', '100.00']])
  assert.ok(!JSON.stringify(result).includes('__norm'), 'no normalization probe leaks into product output')
  assert.ok(!JSON.stringify(result).includes('__nc_'), 'no probe input leaks into product output')
  assert.ok(!JSON.stringify(result).includes('__page_present'), 'no sentinel leaks into product output')
})

test('legacy rows refuse before any row is shaped', async () => {
  const probe = countingClient([{
    month: '2026-01-01',
    new_mrr: '100.0000',
    __page_present: 1,
    ...norm({ __norm_legacy_n: '1', __norm_v1_n: '0', __norm_total: '1', __norm_ver_n: '0', __norm_ver_v: null }),
  }])
  await assert.rejects(runCustomQuery(probe.client, rowsPlan(), opts()), /legacy unnormalized denomination/)
})

test('mixed legacy and normalized rows refuse on the rows path with the real remedy', async () => {
  // Realistic backfill gap: March was never normalized (all-null triple)
  // while April carries a complete v1 USD triple with agreeing evidence.
  // The scope sums exactly to total, so only an explicit legacy-remnant
  // check refuses it.
  const probe = countingClient([
    { month: '2026-03-01', new_mrr: '100.0000', __page_present: 1 },
    { month: '2026-04-01', new_mrr: '150.0000', __page_present: 1 },
  ].map((row) => ({
    ...row,
    ...norm({ __norm_total: '2', __norm_legacy_n: '1', __norm_v1_n: '1' }),
  })))
  await assert.rejects(
    runCustomQuery(probe.client, rowsPlan(), opts()),
    /mix legacy and normalized denominations/,
  )
  const remedyProbe = countingClient([
    { month: '2026-03-01', new_mrr: '100.0000', __page_present: 1 },
    { month: '2026-04-01', new_mrr: '150.0000', __page_present: 1 },
  ].map((row) => ({
    ...row,
    ...norm({ __norm_total: '2', __norm_legacy_n: '1', __norm_v1_n: '1' }),
  })))
  await assert.rejects(runCustomQuery(remedyProbe.client, rowsPlan(), opts()), REMEDY)
})

test('partial, unsupported, and evidence-mismatched rows refuse', async () => {
  const cynosure = (n: Record<string, unknown>) => countingClient([{
    month: '2026-01-01', new_mrr: '100.0000', __page_present: 1, ...n,
  }])
  await assert.rejects(
    runCustomQuery(cynosure(norm({ __norm_total: '1', __norm_legacy_n: '0', __norm_v1_n: '0' })).client, rowsPlan(), opts()),
    /incomplete denomination/,
  )
  await assert.rejects(
    runCustomQuery(cynosure(norm({ __norm_total: '1', __norm_v1_n: '1', __norm_badver_n: '1', __norm_badver_v: 'v7' })).client, rowsPlan(), opts()),
    /unsupported denomination version \(v7\)/,
  )
  await assert.rejects(
    runCustomQuery(cynosure(norm({ __norm_total: '1', __norm_v1_n: '1', __norm_ev_bad_n: '1' })).client, rowsPlan(), opts()),
    /evidence/,
  )
})

test('empty scope stays empty with no refusal', async () => {
  const probe = countingClient([{
    month: null,
    new_mrr: null,
    __page_present: null,
    ...norm({ __norm_total: '0', __norm_legacy_n: '0', __norm_v1_n: '0', __norm_ver_n: '0', __norm_ver_v: null }),
  }])
  const result = await runCustomQuery(probe.client, rowsPlan(), opts())
  assert.equal(result.rowCount, 0)
})

test('governed offset-empty page issues one query with same-statement totals', async () => {
  const entity: ReportEntity = {
    ...REPORT_ENTITY_MAP.saas_metrics_facts!,
    key: 'saas_paged_probe',
    pagination: { defaultPageSize: 5, maxPageSize: 25 },
  }
  const map = { ...REPORT_ENTITY_MAP, saas_paged_probe: entity }
  const probe = countingClient([{
    month: null,
    new_mrr: null,
    __page_present: null,
    ...norm({ __norm_total: '7', __norm_v1_n: '7' }),
  }])
  const result = await runCustomQuery(
    probe.client,
    { ...rowsPlan(), entity: 'saas_paged_probe' },
    opts(map, { page: { offset: 10, limit: 5 } }),
  )
  assert.equal(probe.calls(), 1, 'no second count query on a governed page')
  assert.equal(result.rowCount, 0)
  assert.equal(result.pageInfo?.totalRows, 7)
  assert.equal(result.pageInfo?.hasPrevious, true)
  assert.equal(result.pageInfo?.hasNext, false)
})

test('the sentinel is never counted and product rows carry no hidden keys', async () => {
  const probe = countingClient([
    {
      month: '2026-01-01', new_mrr: '100.0000', __page_present: 1,
      __nc_cur: 'USD', __sort_0: 'x', ...norm({ __norm_total: '2', __norm_v1_n: '2' }),
    },
    {
      month: '2026-02-01', new_mrr: '200.0000', __page_present: 1,
      __nc_cur: 'USD', __sort_0: 'y', ...norm({ __norm_total: '2', __norm_v1_n: '2' }),
    },
  ])
  const result = await runCustomQuery(probe.client, rowsPlan(), opts())
  assert.equal(result.rowCount, 2)
  assert.equal(probe.calls(), 1)
})

test('governed rows compile to one statement with no count probe', () => {
  const compiled = compileCustomQuery(REPORT_ENTITY_MAP.saas_metrics_facts!, rowsPlan(), ORG, {})
  assert.match(compiled.text, /WITH __scope AS/)
  assert.match(compiled.text, /__page AS/)
  assert.match(compiled.text, /__denom AS/)
  assert.match(compiled.text, /RIGHT JOIN __denom ON TRUE/)
  assert.equal(compiled.countText, undefined, 'governed rows carry no second-snapshot count text')
  assert.equal(compiled.hasNormalizationCensus, true)
  assert.ok((compiled.normalizationHiddenColumns ?? []).includes('__page_present'))
  assert.ok((compiled.normalizationHiddenColumns ?? []).includes('__norm_total'))
})

test('governed rows repeat the requested sort after the final join', () => {
  // The join must not silently reorder rows: the outer SELECT carries the
  // exact requested terms — two sort keys here, one selected and one hidden —
  // with direction and NULLS LAST preserved.
  const compiled = compileCustomQuery(REPORT_ENTITY_MAP.saas_metrics_facts!, rowsPlan({
    sorts: [
      { column: 'month', direction: 'desc' },
      { column: 'subsidiary', direction: 'asc' },
    ],
  }), ORG, {})
  assert.match(
    compiled.text,
    /RIGHT JOIN __denom ON TRUE ORDER BY "month" DESC NULLS LAST, "__sort_0" ASC NULLS LAST$/,
  )
  assert.match(compiled.text, /__page AS \(SELECT \*, 1 AS "__page_present" FROM __scope ORDER BY "month" DESC NULLS LAST, "__sort_0" ASC NULLS LAST/)
})

test('governed rows carry unselected sort columns hidden and stripped', () => {
  const compiled = compileCustomQuery(REPORT_ENTITY_MAP.saas_metrics_facts!, rowsPlan({
    sorts: [{ column: 'basis', direction: 'asc' }],
  }), ORG, {})
  assert.match(compiled.text, /RIGHT JOIN __denom ON TRUE ORDER BY "__sort_0" ASC NULLS LAST$/)
  assert.ok((compiled.normalizationHiddenColumns ?? []).includes('__sort_0'))
})

test('rows pins and breakouts never skip the normalization probes', async () => {
  const entity = REPORT_ENTITY_MAP.saas_metrics_facts!
  const pinned = compileCustomQuery(entity, rowsPlan({
    filters: { combinator: 'and', rules: [{ field: 'reporting_currency', op: 'eq', value: 'USD' }] },
  }), ORG, {})
  assert.equal(pinned.hasNormalizationCensus, true)
  const scoped = compileCustomQuery(entity, rowsPlan(), ORG, { allowedSubsidiaryIds: [SUB] })
  assert.equal(scoped.hasNormalizationCensus, true, 'a single subsidiary never suppresses rows normalization truth')
  const probe = countingClient([{
    month: '2026-01-01', new_mrr: '100.0000', __page_present: 1,
    ...norm({ __norm_legacy_n: '1', __norm_v1_n: '0', __norm_total: '1', __norm_ver_n: '0', __norm_ver_v: null }),
  }])
  await assert.rejects(
    runCustomQuery(probe.client, rowsPlan({
      filters: { combinator: 'and', rules: [{ field: 'reporting_currency', op: 'eq', value: 'USD' }] },
    }), opts()),
    /legacy unnormalized denomination/,
  )
})
