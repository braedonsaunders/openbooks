import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../../dashboard/_dashboard-render-harness'
import { mountDashboard } from '../../../dashboard/_dashboard-render-harness'
import type { FilingDetail } from '../../../../../lib/compliance'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { FilingWorksheet } = await import('./FilingWorksheet')

const dir = dirname(fileURLToPath(import.meta.url));
const MESSAGES = join(dir, '..', '..', '..', '..', '..', 'messages');
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'pt-BR', 'zh'] as const;

const loadCompliance = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(MESSAGES, locale, 'compliance.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const catalog = (locale: string): Record<string, string> =>
  (loadCompliance(locale).informationReturns ?? {}) as Record<string, string>;

type EmptyStateKey = 'computedNoRecipients' | 'noRecipients'

function label(locale: string, key: EmptyStateKey): string {
  const value = catalog(locale)[key]
  assert.ok(value, `${locale} is missing compliance.informationReturns.${key}`)
  return value
}

// A computed 1099-NEC filing with 0 recipients once kept showing the
// pre-compute "Nothing computed yet" empty state under the Computed banner.
// The empty state must distinguish never-computed (draft) from
// computed-with-no-recipients — in every locale, never pasted English.
// (Was F-t04-009.)
for (const locale of LOCALES) {
  test(`${locale} labels the computed-with-no-recipients empty state translated`, () => {
    for (const key of ['computedNoRecipients', 'noRecipients'] as const) {
      const text = label(locale, key)
      assert.notEqual(text, key, `${locale} renders the raw key path`)
      if (locale !== 'en') {
        assert.notEqual(
          text,
          label('en', key),
          `${locale} copies the English ${key} — translate it`,
        )
      }
    }
  })
}

function worksheetFiling(status: string): FilingDetail {
  return {
    id: 'filing-1',
    taxYear: 2025,
    formType: '1099-NEC',
    status,
    threshold: '600',
    currency: 'USD',
    subsidiaryName: null,
    computedAt: status === 'draft' ? null : '2026-01-15T12:00:00.000Z',
    finalizedAt: null,
    filedAt: null,
    filingChannel: null,
    filingReference: null,
    includedCount: 0,
    excludedCount: 0,
    missingTinCount: 0,
    filedTotal: '0',
    payerSnapshot: {},
    notes: null,
    recipients: [],
  }
}

test('the worksheet empty state respects a completed compute', async () => {
  const { unmount } = await mountDashboard(
    <FilingWorksheet filing={worksheetFiling('computed')} boxes={[]} canManage={false} canFile={false} />,
    { compliance: loadCompliance('en') },
  )
  try {
    const html = document.body.innerHTML
    assert.ok(
      html.includes(label('en', 'computedNoRecipients')),
      'a computed filing with no recipients names the computed empty state',
    )
    assert.ok(
      !html.includes(label('en', 'noRecipients')),
      'a computed filing must not show the pre-compute empty state',
    )
  } finally {
    await unmount()
  }
})

test('the worksheet empty state shows the pre-compute copy for drafts', async () => {
  const { unmount } = await mountDashboard(
    <FilingWorksheet filing={worksheetFiling('draft')} boxes={[]} canManage={false} canFile={false} />,
    { compliance: loadCompliance('en') },
  )
  try {
    assert.ok(
      document.body.innerHTML.includes(label('en', 'noRecipients')),
      'a never-computed draft names the pre-compute empty state',
    )
  } finally {
    await unmount()
  }
})

test('the worksheet empty state resolves through the catalog, not inline English', async () => {
  const { unmount } = await mountDashboard(
    <FilingWorksheet filing={worksheetFiling('computed')} boxes={[]} canManage={false} canFile={false} />,
    { compliance: loadCompliance('fr') },
    'fr',
  )
  try {
    assert.ok(
      document.body.innerHTML.includes(label('fr', 'computedNoRecipients')),
      'the computed empty state translates',
    )
  } finally {
    await unmount()
  }
})
