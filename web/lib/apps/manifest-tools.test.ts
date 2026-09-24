// Run with:  node --import tsx --test web/lib/apps/manifest-tools.test.ts   (from repo root)
//
// Unit tests for App-declared assistant/MCP tools: the manifest `tools`
// contract (AppToolSpec) and its install-time validation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appToolAssistantName,
  parseManifest,
  validateAppToolsForInstall,
  validateToolInputSchema,
  type AppManifest,
} from './manifest.ts'

const base = {
  key: 'helper-app',
  name: 'Helper App',
  version: '1.0.0',
  permissions: ['records.read', 'custom.invoices.read'],
  frontend: { entry: 'frontend/index.html' },
  endpoints: [{ name: 'lookup', file: 'backend/lookup.js' }],
}

const readSchema = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'Search text', maxLength: 200 },
    limit: { type: 'integer', description: 'Max rows', minimum: 1, maximum: 100 },
  },
  required: ['q'],
}

test('parseManifest accepts a read tool and a mutating tool with defaults', () => {
  const r = parseManifest({
    ...base,
    tools: [
      {
        key: 'lookup',
        title: 'Look up records',
        description: 'Searches the helper index.',
        inputSchema: readSchema,
        handler: 'lookup',
        requiredPermissions: ['records.read'],
      },
      {
        key: 'rebuild',
        title: 'Rebuild the index',
        description: 'Rebuilds the helper index.',
        inputSchema: { type: 'object', properties: {} },
        handler: 'lookup',
        readOnly: false,
        destructive: true,
        confirmation: 'always',
        requiredPermissions: ['records.read'],
      },
    ],
  })
  assert.equal(r.ok, true, r.errors.join('; '))
  const tools = r.manifest!.tools!
  assert.equal(tools.length, 2)
  assert.equal(tools[0]!.readOnly, true)
  assert.equal(tools[0]!.confirmation, 'never')
  assert.equal(tools[0]!.destructive, false)
  assert.equal(tools[1]!.readOnly, false)
  assert.equal(tools[1]!.confirmation, 'always')
})

test('appToolAssistantName snake-cases the app and tool keys', () => {
  assert.equal(appToolAssistantName('helper-app', 'look-up'), 'app_helper_app_look_up')
})

test('parseManifest rejects a tool whose handler is not a declared endpoint', () => {
  const r = parseManifest({
    ...base,
    tools: [
      {
        key: 'lookup',
        title: 'Look up',
        description: 'Searches.',
        inputSchema: readSchema,
        handler: 'missing-endpoint',
      },
    ],
  })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /handler "missing-endpoint" is not a declared endpoint/)
})

test('parseManifest rejects a mutating tool without always-confirmation', () => {
  const r = parseManifest({
    ...base,
    tools: [
      {
        key: 'rebuild',
        title: 'Rebuild',
        description: 'Rebuilds.',
        inputSchema: { type: 'object', properties: {} },
        handler: 'lookup',
        readOnly: false,
        confirmation: 'never',
      },
    ],
  })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /mutating tools require confirmation "always"/)
})

test('parseManifest rejects a destructive read-only tool', () => {
  const r = parseManifest({
    ...base,
    tools: [
      {
        key: 'lookup',
        title: 'Look up',
        description: 'Searches.',
        inputSchema: readSchema,
        handler: 'lookup',
        destructive: true,
      },
    ],
  })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /read-only tools cannot be destructive/)
})

test('parseManifest rejects requiredPermissions outside the requested set', () => {
  const r = parseManifest({
    ...base,
    tools: [
      {
        key: 'lookup',
        title: 'Look up',
        description: 'Searches.',
        inputSchema: readSchema,
        handler: 'lookup',
        requiredPermissions: ['gl.post'],
      },
    ],
  })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /requiredPermissions.*"gl\.post".*not requested/)
})

test('parseManifest rejects duplicate tool keys', () => {
  const tool = {
    key: 'lookup',
    title: 'Look up',
    description: 'Searches.',
    inputSchema: readSchema,
    handler: 'lookup',
  }
  const r = parseManifest({ ...base, tools: [tool, { ...tool, title: 'Again' }] })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /duplicate tool key: lookup/)
})

test('validateToolInputSchema requires a plain object schema with properties', () => {
  for (const bad of [null, 42, 'x', [], { type: 'string', properties: {} }, { type: 'object' }]) {
    assert.ok(validateToolInputSchema(bad).length > 0, JSON.stringify(bad))
  }
  assert.deepEqual(validateToolInputSchema({ type: 'object', properties: {} }), [])
})

test('validateToolInputSchema enforces bounded strings, arrays, and enums', () => {
  const unboundedString = {
    type: 'object',
    properties: { q: { type: 'string', description: 'q' } },
  }
  assert.match(validateToolInputSchema(unboundedString).join('\n'), /maxLength/)
  const unboundedArray = {
    type: 'object',
    properties: { ids: { type: 'array', description: 'ids', items: { type: 'string' } } },
  }
  assert.match(validateToolInputSchema(unboundedArray).join('\n'), /maxItems/)
  const bigEnum = {
    type: 'object',
    properties: { k: { type: 'string', description: 'k', maxLength: 10, enum: Array.from({ length: 65 }, (_, i) => `v${i}`) } },
  }
  assert.match(validateToolInputSchema(bigEnum).join('\n'), /enum/)
})

test('validateToolInputSchema rejects non-RE2 patterns', () => {
  const schema = (pattern: string) => ({
    type: 'object',
    properties: { q: { type: 'string', description: 'q', maxLength: 20, pattern } },
  })
  assert.match(validateToolInputSchema(schema('^(?!admin).*')).join('\n'), /pattern/)
  assert.match(validateToolInputSchema(schema('(?<=x)y')).join('\n'), /pattern/)
  assert.match(validateToolInputSchema(schema('(a)\\1')).join('\n'), /pattern/)
  assert.deepEqual(validateToolInputSchema(schema('^[a-z0-9-]+$')), [])
})

test('validateToolInputSchema rejects composition keywords and deep nesting', () => {
  assert.ok(validateToolInputSchema({ type: 'object', properties: {}, allOf: [] }).length > 0)
  assert.ok(validateToolInputSchema({ type: 'object', properties: {}, $ref: '#/x' }).length > 0)
  const deep = (n: number): unknown =>
    n === 0
      ? { type: 'string', description: 'leaf', maxLength: 5 }
      : { type: 'object', description: `level ${n}`, properties: { child: deep(n - 1) } }
  assert.ok(validateToolInputSchema({ type: 'object', properties: { child: deep(4) } }).length > 0)
  assert.deepEqual(validateToolInputSchema({ type: 'object', properties: { child: deep(1) } }), [])
})

test('parseManifest surfaces inputSchema errors with the tool path', () => {
  const r = parseManifest({
    ...base,
    tools: [
      {
        key: 'lookup',
        title: 'Look up',
        description: 'Searches.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        handler: 'lookup',
      },
    ],
  })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /tools\.0\.inputSchema/)
})

test('manifests without tools keep working and default to an empty list', () => {
  const r = parseManifest(base)
  assert.equal(r.ok, true)
  assert.deepEqual((r.manifest as AppManifest).tools, [])
})

const tooledManifest = () =>
  parseManifest({
    ...base,
    tools: [
      {
        key: 'lookup',
        title: 'Look up',
        description: 'Searches.',
        inputSchema: readSchema,
        handler: 'lookup',
        requiredPermissions: ['records.read'],
      },
    ],
  }).manifest as AppManifest

test('validateAppToolsForInstall accepts granted-subset tools with free names', () => {
  assert.deepEqual(
    validateAppToolsForInstall(tooledManifest(), ['records.read', 'custom.invoices.read'], new Set(['whoami'])),
    [],
  )
})

test('validateAppToolsForInstall rejects tools requiring ungranted permissions', () => {
  const errors = validateAppToolsForInstall(tooledManifest(), ['custom.invoices.read'], new Set())
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /tool "lookup" requires "records\.read" which is not granted/)
})

test('validateAppToolsForInstall rejects assistant-name collisions with built-in tools', () => {
  const errors = validateAppToolsForInstall(
    tooledManifest(),
    ['records.read'],
    new Set(['app_helper_app_lookup']),
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /collides with a built-in tool/)
})
