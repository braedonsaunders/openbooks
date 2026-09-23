import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * A status the page can render but no locale names renders as its own raw
 * enum string — `incomplete` instead of "Incomplete". That shipped for every
 * export and document status on /me/documents: the loader reads
 * meDocuments.status.<value> with a raw-value fallback, and no locale
 * defined meDocuments.status at all, so the fallback was the whole UI.
 *
 * So derive it. The storage CHECK constraints are the source of truth for
 * which statuses exist; the test reads the latest definition of each
 * constraint out of the migration chain and requires a non-empty
 * meDocuments.status label for every value in every locale. A hand-listed
 * copy of the statuses here could only ROT — the next status would ship
 * unlabeled — so there isn't one.
 */

const ROOT = process.cwd()
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'zh', 'pt-BR'] as const

function checkStatuses(constraint: string): string[] {
  const dir = join(ROOT, 'schema', 'migrations', 'generated')
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const pattern = new RegExp(
    `ADD CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(\\s*status\\s+IN\\s*\\(([^)]*)\\)`,
    'gs',
  )
  let latest: string[] | null = null
  let definedIn = ''
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const match of source.matchAll(pattern)) {
      latest = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
      definedIn = file
    }
  }
  assert.ok(
    latest && latest.length > 0,
    `${constraint} has no CHECK definition in schema/migrations/generated — the derivation source moved; point this test at it, never hand-list the statuses (last seen in ${definedIn || 'no file'})`,
  )
  return latest
}

const exportStatuses = checkStatuses('hrm_data_subject_exports_status')
const documentStatuses = checkStatuses('hrm_documents_status')

test('every export and document status has a Me label in every locale', () => {
  const wanted = [...exportStatuses, ...documentStatuses]
  for (const locale of LOCALES) {
    const catalog = JSON.parse(
      readFileSync(join(ROOT, 'web', 'messages', locale, 'hrm.json'), 'utf8'),
    ) as { meDocuments?: { status?: Record<string, unknown> } }
    for (const status of wanted) {
      const label = catalog.meDocuments?.status?.[status]
      assert.ok(
        typeof label === 'string' && label.length > 0,
        `${locale} has no meDocuments.status.${status}, so /me/documents renders the raw enum string — add the label to web/messages/${locale}/hrm.json`,
      )
    }
  }
})
