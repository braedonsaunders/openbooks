import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import {
  FALLBACK_MANIFEST_PATH,
  completenessReport,
  generateFallbackManifest,
  readFallbackManifest,
} from '../web/lib/i18n-catalog-completeness.ts'

const writeManifest = process.argv.includes('--write-manifest')
const generated = generateFallbackManifest()

if (writeManifest) {
  writeFileSync(FALLBACK_MANIFEST_PATH, `${JSON.stringify(generated, null, 2)}\n`)
}

assert.deepEqual(
  readFallbackManifest(),
  generated,
  'untranslated fallback manifest is stale; rerun with --write-manifest',
)

for (const row of completenessReport(generated)) {
  process.stdout.write(
    `${row.locale}: translated=${row.translated}/${row.sourceKeys} ` +
    `untranslated=${row.untranslated} declaredFallbacks=${row.declaredFallbacks} ` +
    `coverage=${row.coverage}%\n`,
  )
}
