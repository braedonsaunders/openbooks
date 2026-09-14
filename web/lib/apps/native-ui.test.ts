import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNativeExtension } from './native-ui'
import { parseObjectSpecs } from './objects'
import { parseManifest } from './manifest'

const spec = { specVersion: 1, layout: 'list', header: [], body: [{ kind: 'text', content: 'Inspection workspace' }] }
const parse = (screens: unknown[]) => parseNativeExtension(JSON.stringify({ screens }))
test('native extension composes pages and shared record screens', () => {
  assert.equal(parse([{ key: 'intro', title: 'Overview', kind: 'page', spec }, { key: 'checks', title: 'Checks', kind: 'records', typeKey: 'equipment-check' }]).screens.length, 2)
  assert.equal(parseManifest({ key: 'checks', name: 'Checks', version: '1.0.0', frontend: { entry: 'frontend/ui.json', renderer: 'native' } }).ok, true)
})
test('native extension refuses duplicate screens and ambient server widgets', () => {
  const screen = { key: 'intro', title: 'Overview', kind: 'page', spec }
  assert.equal(parse([{ ...screen, spec: { ...spec, body: [{ kind: 'widget', widget: 'link-button', props: { href: '/records/checks', label: 'Checks' } }] } }]).screens.length, 1)
  assert.throws(() => parse([screen, screen]), /duplicate screen/)
  assert.throws(() => parse([{ ...screen, spec: { ...spec, body: [{ kind: 'widget', widget: 'native-extension', props: { appKey: 'other' } }] } }]))
  assert.throws(() => parse([{ ...screen, spec: { ...spec, body: [{ kind: 'widget', widget: 'link-button', props: { dangerousHtml: '<script>' } }] } }]))
  assert.throws(() => parse([{ key: 'a', title: 'A', kind: 'records', typeKey: '../foreign' }]))
})
test('native record package uses the shared validated form vocabulary', () => {
  const objects = parseObjectSpecs([{ path: 'objects/checks.json', content: JSON.stringify({ type: 'record_type', key: 'equipment-check', name: 'Equipment check', fields: [{ id: 'details', fields: [{ id: 'equipment', type: 'text', label: 'Equipment', required: true }, { id: 'notes', type: 'long_text', label: 'Notes' }] }] }) }])
  assert.deepEqual(objects.errors, [])
  assert.equal(objects.recordTypes.length, 1)
})
