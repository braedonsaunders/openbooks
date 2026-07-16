// Run with:  node --import tsx --test web/lib/apps/zip.test.ts   (from repo root)
//
// Unit tests for zip-bundle parsing and objects/*.json spec validation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, strToU8 } from 'fflate'
import { parseZipBundle, ZipBundleError } from './zip.ts'
import { parseObjectSpecs } from './objects.ts'

const MANIFEST = JSON.stringify({
  key: 'demo',
  name: 'Demo',
  version: '1.0.0',
  frontend: { entry: 'frontend/index.html' },
})

test('parses a root-level bundle: text utf8, binaries base64, junk skipped', () => {
  const zip = zipSync({
    'manifest.json': strToU8(MANIFEST),
    'frontend/index.html': strToU8('<html>hi</html>'),
    'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    '__MACOSX/frontend/._index.html': strToU8('junk'),
    '.DS_Store': strToU8('junk'),
  })
  const b = parseZipBundle(zip)
  assert.deepEqual((b.manifest as any).key, 'demo')
  const paths = b.files.map((f) => f.path).sort()
  assert.deepEqual(paths, ['frontend/index.html', 'logo.png'])
  const html = b.files.find((f) => f.path === 'frontend/index.html')!
  assert.equal(html.isBinary, false)
  assert.equal(html.content, '<html>hi</html>')
  const png = b.files.find((f) => f.path === 'logo.png')!
  assert.equal(png.isBinary, true)
  assert.equal(Buffer.from(png.content, 'base64')[0], 0x89)
})

test('unwraps the single-root-folder shape (right-click compress)', () => {
  const zip = zipSync({
    'my-app/manifest.json': strToU8(MANIFEST),
    'my-app/frontend/index.html': strToU8('<html></html>'),
  })
  const b = parseZipBundle(zip)
  assert.deepEqual(b.files.map((f) => f.path), ['frontend/index.html'])
})

test('missing manifest is a clean error', () => {
  const zip = zipSync({ 'frontend/index.html': strToU8('<html></html>') })
  assert.throws(() => parseZipBundle(zip), ZipBundleError)
})

test('invalid manifest JSON is a clean error', () => {
  const zip = zipSync({ 'manifest.json': strToU8('{nope') })
  assert.throws(() => parseZipBundle(zip), /not valid JSON/)
})

test('garbage bytes are a clean error, not a crash', () => {
  assert.throws(() => parseZipBundle(new Uint8Array([1, 2, 3, 4])), ZipBundleError)
})

// ---------------------------------------------------------------------------
// objects/*.json specs
// ---------------------------------------------------------------------------

const RT = {
  type: 'record_type',
  key: 'warranty',
  name: 'Warranty',
  pluralName: 'Warranties',
  fields: [{ id: 'main', title: 'Details', fields: [{ id: 'serial', label: 'Serial #', type: 'text' }] }],
}
const CF = {
  type: 'custom_field',
  targetTable: 'documents',
  targetKind: 'vendor_bill',
  key: 'warranty_ref',
  label: 'Warranty Ref',
  fieldType: 'text',
}

test('valid record_type and custom_field specs parse', () => {
  const r = parseObjectSpecs([
    { path: 'objects/warranty.json', content: JSON.stringify(RT) },
    { path: 'objects/warranty-ref.json', content: JSON.stringify(CF) },
    { path: 'frontend/index.html', content: '<html></html>' }, // ignored
  ])
  assert.deepEqual(r.errors, [])
  assert.equal(r.recordTypes.length, 1)
  assert.equal(r.recordTypes[0]!.key, 'warranty')
  assert.equal(r.recordTypes[0]!.showInNav, true)
  assert.equal(r.customFields.length, 1)
  assert.equal(r.customFields[0]!.targetKind, 'vendor_bill')
})

test('bad slug, unknown fieldType, unknown target are flagged', () => {
  const r = parseObjectSpecs([
    { path: 'objects/a.json', content: JSON.stringify({ ...RT, key: 'Bad Key' }) },
    { path: 'objects/b.json', content: JSON.stringify({ ...CF, fieldType: 'magic' }) },
    { path: 'objects/c.json', content: JSON.stringify({ ...CF, targetTable: 'journal_entries' }) },
  ])
  assert.equal(r.errors.length, 3)
  assert.match(r.errors[0]!, /slug/)
  assert.match(r.errors[1]!, /fieldType/)
  assert.match(r.errors[2]!, /targetTable/)
})

test('duplicate keys within a bundle are flagged', () => {
  const r = parseObjectSpecs([
    { path: 'objects/a.json', content: JSON.stringify(RT) },
    { path: 'objects/b.json', content: JSON.stringify(RT) },
  ])
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0]!, /duplicate record_type/)
})

test('invalid record fields are rejected by the shared lint', () => {
  const r = parseObjectSpecs([
    { path: 'objects/a.json', content: JSON.stringify({ ...RT, fields: [{ nonsense: true }] }) },
  ])
  assert.equal(r.recordTypes.length, 0)
  assert.equal(r.errors.length, 1)
})

test('unknown type value is flagged', () => {
  const r = parseObjectSpecs([{ path: 'objects/a.json', content: JSON.stringify({ type: 'workflow' }) }])
  assert.match(r.errors[0]!, /must be "record_type" or "custom_field"/)
})
