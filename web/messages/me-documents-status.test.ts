// source-pin-contract: status-label coverage invariant — every HR export and document status allowed by the latest published CHECK constraint has a Me label in every locale; statuses derived from the release schema, never hand-listed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LOCALE_CODES as LOCALES } from "../i18n/config"
import { releaseSchemaFiles } from "../../scripts/release-schema-sql.mjs"

/**
 * A status the page can render but no locale names renders as its own raw
 * enum string — `incomplete` instead of "Incomplete". That shipped for every
 * export and document status on /me/documents: the loader reads
 * meDocuments.status.<value> with a raw-value fallback, and no locale
 * defined meDocuments.status at all, so the fallback was the whole UI.
 * So derive it. The storage CHECK constraints are the source of truth for
 * which statuses exist; the test reads the latest definition of each
 * constraint out of the release schema and requires a non-empty
 * meDocuments.status label for every value in every locale. A hand-listed
 * copy of the statuses here could only ROT — the next status would ship
 * unlabeled — so there isn't one.
 */

const ROOT = process.cwd()

function checkStatuses(constraint: string): string[] {
  // The release schema is the baseline (pg_dump form: an inline
  // `CONSTRAINT x CHECK ((status = ANY (ARRAY['a'::text, ...])))`) followed
  // by forward migrations, which may redefine the constraint in either that
  // form or `CHECK (status IN ('a', ...))`. The last definition wins.
  const pattern = new RegExp(
    `CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(\\s*\\(?\\s*status\\s+(?:IN\\s*\\(([^)]*)\\)|=\\s*ANY\\s*\\(\\s*\\(?\\s*ARRAY\\[([^\\]]*)\\])`,
    'gs',
  )
  let latest: string[] | null = null
  let definedIn = ''
  for (const { filename, path } of releaseSchemaFiles(ROOT)) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(pattern)) {
      latest = [...(match[1] ?? match[2]!).matchAll(/'([^']+)'/g)].map((m) => m[1]!)
      definedIn = filename
    }
  }
  assert.ok(
    latest && latest.length > 0,
    `${constraint} has no CHECK definition in the release schema — the derivation source moved; point this test at it, never hand-list the statuses (last seen in ${definedIn || 'no file'})`,
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
