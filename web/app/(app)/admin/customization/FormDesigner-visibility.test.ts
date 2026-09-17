import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./FormDesigner.tsx', import.meta.url), 'utf8')

/**
 * F-t10-003 — the designer visibility toggles (tabs, subtabs, actions,
 * fields) kept aria-label "Visible" in both states with no pressed state:
 * state by colour only. Every visibility toggle must expose aria-pressed
 * and flip its label between Visible and Hidden.
 */
test('designer visibility toggles expose pressed state and a hidden label', () => {
  const toggles = source.match(/aria-label=\{t\('designer\.forms\.visible'\)\}/g) ?? []
  assert.equal(toggles.length, 0, `no visibility toggle may keep a static "Visible" label (${toggles.length} found)`)
  assert.match(source, /aria-pressed=\{tab\.visible\}/, 'tab toggle exposes pressed state')
  assert.match(source, /aria-pressed=\{subtab\.visible\}/, 'subtab toggle exposes pressed state')
  assert.match(source, /aria-pressed=\{action\.visible\}/, 'action toggle exposes pressed state')
  assert.match(source, /aria-pressed=\{field\.visible\}/, 'field toggle exposes pressed state')
})
