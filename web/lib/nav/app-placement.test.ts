import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const resolveSource = readFileSync(new URL('./resolve.ts', import.meta.url), 'utf8')
const editorSource = readFileSync(
  new URL('../../app/(app)/admin/navigation/NavEditor.tsx', import.meta.url),
  'utf8',
)
const appSchemaSource = readFileSync(new URL('../../../schema/src/apps.ts', import.meta.url), 'utf8')

test('installing an app cannot implicitly place it in organization navigation', () => {
  assert.doesNotMatch(resolveSource, /layerInNavApps|a\.show_in_nav/)
  assert.doesNotMatch(appSchemaSource, /showInNav|show_in_nav/)
})

test('navigation editor can remove an app shortcut without uninstalling the app', () => {
  assert.match(editorSource, /item\.kind === 'link' \|\| item\.kind === 'app'/)
  assert.match(editorSource, /t\('removeApp'\)/)
  assert.doesNotMatch(editorSource, /method:\s*'DELETE'/)
})
