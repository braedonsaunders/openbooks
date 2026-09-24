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

const loadCompliance = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(MESSAGES, locale, 'compliance.json'), 'utf8')) as Record<
    string,
    unknown
  >;

// A void 1099 filing once wore the green success badge — the same tone as a
// filed return — so a voided filing passed for a completed one at a glance.
// (Was F3-86.) The badge tone is asserted through the rendered classes, not
// the source: secondary is the slate pair, success the green pair, warning
// the amber pair.
function worksheetFiling(status: string): FilingDetail {
  return {
    id: 'filing-1',
    taxYear: 2025,
    formType: '1099-NEC',
    status,
    threshold: '600',
    currency: 'USD',
    subsidiaryName: null,
    computedAt: '2026-01-15T12:00:00.000Z',
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

function badgeClassFor(label: string): string {
  const badges = [...document.body.querySelectorAll('div')].filter(
    (node) => node.textContent === label && node.className.includes('rounded-full'),
  )
  assert.equal(badges.length, 1, `expected exactly one status badge reading ${label}`)
  return String(badges[0]!.className)
}

for (const [status, label, expected, forbidden] of [
  ['void', 'Void', 'bg-slate-100', 'bg-green-50'],
  ['filed', 'Filed', 'bg-green-50', 'bg-slate-100'],
  ['finalized', 'Finalized', 'bg-green-50', 'bg-slate-100'],
  ['draft', 'Draft', 'bg-amber-50', 'bg-green-50'],
] as const) {
  test(`a ${status} filing badge renders in the ${expected} tone`, async () => {
    const { unmount } = await mountDashboard(
      <FilingWorksheet filing={worksheetFiling(status)} boxes={[]} canManage={false} canFile={false} />,
      { compliance: loadCompliance('en') },
    )
    try {
      const className = badgeClassFor(label)
      assert.ok(
        className.includes(expected),
        `a ${status} filing badge must carry ${expected}, got: ${className}`,
      )
      assert.ok(
        !className.includes(forbidden),
        `a ${status} filing badge must not carry ${forbidden}, got: ${className}`,
      )
    } finally {
      await unmount()
    }
  })
}
