// Run with:  node --import tsx --test web/lib/apps/tool-schema.test.ts   (from repo root)
//
// Unit tests for App-tool schema conversion, input validation, and the
// permission-intersection renderer. Pure: no database, no server-only chain.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  jsonSchemaToZod,
  parseToolInput,
  renderAppToolViews,
  type AppToolSource,
} from './tool-schema.ts'

const lookupSchema = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'Search text', maxLength: 200 },
    limit: { type: 'integer', description: 'Max rows', minimum: 1, maximum: 100 },
    kind: { type: 'string', description: 'Kind', maxLength: 20, enum: ['a', 'b'] },
  },
  required: ['q'],
}

function source(overrides: Partial<AppToolSource> = {}, toolOverrides = {}): AppToolSource {
  return {
    key: 'helper-app',
    name: 'Helper App',
    status: 'installed',
    grantedPermissions: ['records.read'],
    manifest: {
      tools: [
        {
          key: 'lookup',
          title: 'Look up',
          description: 'Searches the helper index.',
          inputSchema: lookupSchema,
          handler: 'lookup',
          readOnly: true,
          destructive: false,
          confirmation: 'never',
          requiredPermissions: ['records.read'],
          ...toolOverrides,
        },
      ],
    },
    ...overrides,
  }
}

const actor = (permissions: string[], appsUse = true) => ({
  permissions: new Set(permissions),
  appsUse,
})

test('jsonSchemaToZod enforces bounds, enums, and required fields', () => {
  const schema = jsonSchemaToZod(lookupSchema)
  assert.deepEqual(schema.parse({ q: 'x' }), { q: 'x' })
  assert.throws(() => schema.parse({}), /q/)
  assert.throws(() => schema.parse({ q: 'x'.repeat(201) }), /q/)
  assert.throws(() => schema.parse({ q: 'x', limit: 1.5 }), /limit/)
  assert.throws(() => schema.parse({ q: 'x', kind: 'c' }), /kind/)
  assert.deepEqual(schema.parse({ q: 'x', kind: 'a', limit: 5 }), { q: 'x', kind: 'a', limit: 5 })
})

test('jsonSchemaToZod rejects additional properties only under strict mode', () => {
  const loose = jsonSchemaToZod(lookupSchema)
  assert.deepEqual(loose.parse({ q: 'x', extra: 1 }), { q: 'x' })
  const strict = jsonSchemaToZod({ ...lookupSchema, additionalProperties: false })
  assert.throws(() => strict.parse({ q: 'x', extra: 1 }), /extra/)
})

test('parseToolInput returns precise invalid_input errors without throwing', () => {
  const schema = jsonSchemaToZod(lookupSchema)
  assert.deepEqual(parseToolInput(schema, { q: 'x' }), { ok: true, value: { q: 'x' } })
  const bad = parseToolInput(schema, { limit: 3 })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /invalid_input/)
  assert.match(bad.error, /q/)
  assert.equal(parseToolInput(schema, null).ok, false)
})

test('renderAppToolViews renders installed tools the actor may see', () => {
  const views = renderAppToolViews([source()], actor(['apps.use', 'records.read', 'assistant.use']), true)
  assert.equal(views.length, 1)
  const view = views[0]!
  assert.equal(view.name, 'app_helper_app_lookup')
  assert.equal(view.title, 'Look up')
  assert.equal(view.description, 'Helper App: Searches the helper index.')
  assert.equal(view.readOnly, true)
})

test('renderAppToolViews hides tools on every gate failure', () => {
  const rows = [source()]
  // Apps feature off.
  assert.deepEqual(renderAppToolViews(rows, actor(['apps.use', 'records.read']), false), [])
  // Caller may not use apps at all.
  assert.deepEqual(renderAppToolViews(rows, actor(['records.read'], false), true), [])
  // User lacks a required permission.
  assert.deepEqual(renderAppToolViews(rows, actor(['apps.use']), true), [])
  // App lost the grant after install.
  assert.deepEqual(
    renderAppToolViews([source({ grantedPermissions: [] })], actor(['apps.use', 'records.read']), true),
    [],
  )
  // Disabled apps expose nothing.
  assert.deepEqual(
    renderAppToolViews([source({ status: 'disabled' })], actor(['apps.use', 'records.read']), true),
    [],
  )
  // Manifest without tools exposes nothing.
  assert.deepEqual(
    renderAppToolViews([source({ manifest: { tools: [] } })], actor(['apps.use', 'records.read']), true),
    [],
  )
})

test('renderAppToolViews honors wildcard grants like the bridge does', () => {
  const views = renderAppToolViews([source()], actor(['apps.use', '*']), true)
  assert.equal(views.length, 1)
})

test('renderAppToolViews skips tools whose stored schema no longer converts', () => {
  const views = renderAppToolViews(
    [source({}, { inputSchema: { type: 'object' } })],
    actor(['apps.use', 'records.read']),
    true,
  )
  assert.deepEqual(views, [])
})

test('renderAppToolViews keeps mutating-tool confirmation and destructive flags', () => {
  const views = renderAppToolViews(
    [
      source(
        {},
        {
          key: 'rebuild',
          title: 'Rebuild',
          description: 'Rebuilds.',
          inputSchema: { type: 'object', properties: {} },
          readOnly: false,
          destructive: true,
          confirmation: 'always',
          requiredPermissions: [],
        },
      ),
    ],
    actor(['apps.use']),
    true,
  )
  assert.equal(views.length, 1)
  assert.equal(views[0]!.readOnly, false)
  assert.equal(views[0]!.confirmation, 'always')
  assert.equal(views[0]!.destructive, true)
})
