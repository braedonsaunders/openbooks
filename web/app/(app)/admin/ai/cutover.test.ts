import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Cutover contract for the provider/agents split: the AI provider page owns
 * provider credentials and document capture ONLY — pack configuration
 * (array, drawer, run-now) lives under Setup → Agents.
 *
 * The load-bearing assertion is the provider-save semantic: a PUT without an
 * `agents` array must leave every pack policy untouched. Before the split the
 * form always sent the full array, so `normalizeAgentSettingsInput(undefined)`
 * defaulting every pack to disabled was harmless; after the split the same
 * default would wipe all packs on every provider save. The route therefore
 * persists agents only when the caller sent them (see the DB proof in
 * web/lib/setup/agents.integration.test.ts).
 */

const thisDir = import.meta.dirname
const form = readFileSync(join(thisDir, 'AiSettingsForm.tsx'), 'utf8')
const view = readFileSync(join(thisDir, 'view.ts'), 'utf8')
const providerRoute = readFileSync(join(thisDir, '..', '..', '..', 'api', 'admin', 'ai', 'route.ts'), 'utf8')

test('the provider form owns no agent configuration surface', () => {
  for (const relic of [
    'AgentConfigurationDrawer',
    'detectorSpecs',
    'selectedAgentKey',
    'updateAgent',
    'runningAgent',
    '?agent=',
    '/api/continuous-close/run',
    '/api/admin/ai/agents/',
  ]) {
    assert.doesNotMatch(form, new RegExp(relic.replace(/[?/]/g, (c) => `\\${c}`)), `provider form must not reference ${relic}`)
  }
  assert.match(form, /\/admin\/setup\/agents/, 'provider form must cross-link the Agents setup area')
})

test('the provider view loads no agent policy or drawer selection', () => {
  for (const relic of ['selectedAgentKey', 'detectorSpecs', 'isContinuousCloseAgentKey', 'allowedAgentKeys']) {
    assert.doesNotMatch(view, new RegExp(relic), `provider view must not reference ${relic}`)
  }
  assert.match(view, /requirePermission\(['"]admin\.ai\.manage['"]\)/, 'provider page keeps its own gate')
})

test('the provider cross-links render through the shared button', () => {
  // Both neighbour links (Agents setup, capture queue) must ride Button
  // asChild — never a bare anchor — so they keep house geometry.
  for (const href of ['/admin/setup/agents', '/ap/capture']) {
    const at = form.indexOf(`href="${href}"`)
    assert.ok(at !== -1, `provider form must link ${href}`)
    const buttonAt = form.lastIndexOf('<Button', at)
    assert.ok(buttonAt !== -1 && form.slice(buttonAt, at).includes('asChild'), `${href} must render inside Button asChild`)
  }
  assert.doesNotMatch(
    form,
    /<button type="button" onClick=\{clearDocumentCaptureKey\}/,
    'the remove-key action must use the shared Button, not a hand-rolled button',
  )
})

test('the provider save persists agents only when the caller sent them', () => {
  assert.match(
    providerRoute,
    /body\.agents === undefined \? \[\] : normalizeAgentSettingsInput\(body\.agents\)/,
    'omitting agents must mean "leave policies alone", never "reset all packs to defaults"',
  )
})
