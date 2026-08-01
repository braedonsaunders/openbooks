// Run with:  node --import tsx --test web/lib/apps/manifest.test.ts   (from repo root)
//
// Unit tests for App manifest parsing, bundle validation, and content typing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_PLATFORM_PERMISSIONS, parseManifest, validateBundle, contentTypeFor, type AppManifest } from './manifest.ts'

const good = {
  key: 'expense-helper',
  name: 'Expense Helper',
  version: '1.0.0',
  description: 'Totals expenses',
  permissions: ['records.read'],
  frontend: { entry: 'frontend/index.html' },
  endpoints: [
    { name: 'total', file: 'backend/total.js' },
    { name: 'save', file: 'backend/save.js', method: 'POST' },
  ],
  nav: { show: true, label: 'Expense Helper' },
}

test('parseManifest accepts a valid manifest and applies defaults', () => {
  const r = parseManifest(good)
  assert.equal(r.ok, true)
  assert.equal(r.manifest!.endpoints[0]!.method, 'ANY') // default
  assert.equal(r.manifest!.endpoints[1]!.method, 'POST')
  assert.deepEqual(r.manifest!.permissions, ['records.read'])
})

test('parseManifest rejects a bad slug key', () => {
  const r = parseManifest({ ...good, key: 'Bad Key!' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /key must be a slug/)
})

test('parseManifest rejects a bad version', () => {
  const r = parseManifest({ ...good, version: 'v-one' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /version/)
})

test('parseManifest rejects path traversal in entry', () => {
  const r = parseManifest({ ...good, frontend: { entry: '../../etc/passwd' } })
  assert.equal(r.ok, false)
})

test('parseManifest rejects duplicate endpoint names', () => {
  const r = parseManifest({
    ...good,
    endpoints: [
      { name: 'x', file: 'a.js' },
      { name: 'x', file: 'b.js' },
    ],
  })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /duplicate endpoint name/)
})

test('parseManifest requires a frontend entry', () => {
  const { frontend, ...noFrontend } = good
  const r = parseManifest(noFrontend)
  assert.equal(r.ok, false)
})

test('validateBundle checks referenced files exist and classifies kinds', () => {
  const m = parseManifest(good).manifest as AppManifest
  const paths = ['frontend/index.html', 'frontend/app.js', 'backend/total.js', 'backend/save.js', 'logo.png']
  const v = validateBundle(m, paths)
  assert.equal(v.ok, true)
  assert.equal(v.kinds['frontend/index.html'], 'frontend')
  assert.equal(v.kinds['frontend/app.js'], 'frontend')
  assert.equal(v.kinds['backend/total.js'], 'backend')
  assert.equal(v.kinds['logo.png'], 'asset')
})

test('validateBundle flags a missing entry file', () => {
  const m = parseManifest(good).manifest as AppManifest
  const v = validateBundle(m, ['backend/total.js', 'backend/save.js'])
  assert.equal(v.ok, false)
  assert.match(v.errors.join('\n'), /frontend entry not found/)
})

test('validateBundle flags a missing endpoint file', () => {
  const m = parseManifest(good).manifest as AppManifest
  const v = validateBundle(m, ['frontend/index.html', 'backend/total.js'])
  assert.equal(v.ok, false)
  assert.match(v.errors.join('\n'), /save.*not found/)
})

test('contentTypeFor maps extensions and binary flag', () => {
  assert.deepEqual(contentTypeFor('a/b.html'), { contentType: 'text/html; charset=utf-8', binary: false })
  assert.equal(contentTypeFor('x.js').contentType, 'text/javascript; charset=utf-8')
  assert.equal(contentTypeFor('logo.png').binary, true)
  assert.equal(contentTypeFor('font.woff2').binary, true)
  assert.equal(contentTypeFor('weird.xyz').contentType, 'text/plain; charset=utf-8')
})

test('platform permission catalogue covers every record API read and write surface', () => {
  for (const permission of ['gl.read', 'ap.read', 'ap.create', 'ar.read', 'ar.create', 'parties.manage', 'records.create']) {
    assert.equal(APP_PLATFORM_PERMISSIONS.includes(permission), true, permission)
  }
})
