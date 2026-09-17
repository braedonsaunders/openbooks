import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(new URL('./ListViewDesigner.tsx', import.meta.url), 'utf8')
const here = dirname(fileURLToPath(import.meta.url))

/**
 * F-t05-011 — deleting a saved list view fired on one click with no
 * confirmation. Like the banking rule drawer, remove() must confirm first
 * through a localized string.
 */
test('deleting a saved view confirms before the DELETE goes out', () => {
  assert.match(
    source,
    /async function remove\(\)[\s\S]{0,200}confirm\(/,
    'remove() must ask for confirmation before deleting the view',
  )
  assert.match(
    source,
    /designer\.list\.deleteConfirm/,
    'the confirmation names the consequence through a localized string',
  )
})

for (const locale of ['en', 'fr', 'es']) {
  test(`F-t05-011: view delete confirmation is translated in ${locale}`, () => {
    const catalog = JSON.parse(
      readFileSync(join(here, '..', '..', '..', '..', 'messages', locale, 'customization.json'), 'utf8'),
    ) as { designer?: { list?: Record<string, unknown> } }
    assert.equal(
      typeof catalog.designer?.list?.deleteConfirm,
      'string',
      `${locale} designer.list.deleteConfirm must exist`,
    )
  })
}
