import assert from 'node:assert/strict'
import test from 'node:test'
import { scanSource } from './check-viewer-locale.mjs'

test('viewer locale checker rejects locale-omitting and hardcoded locale formatting', () => {
  const violations = scanSource(`
    function render(value) {
      return [value.toLocaleString(), new Intl.DateTimeFormat().format(value),
        new Intl.NumberFormat('en-CA').format(123)];
    }
  `, 'web/components/locale-fixture.tsx')
  assert.equal(violations.length, 3)
})

test('viewer locale checker accepts an explicitly supplied viewer locale', () => {
  const violations = scanSource(`
    function render(value, locale) {
      return [value.toLocaleDateString(locale), new Intl.DateTimeFormat(locale).format(value),
        new Intl.NumberFormat(locale).format(123)];
    }
  `, 'web/app/(app)/locale-fixture.tsx')
  assert.deepEqual(violations, [])
})

test('viewer locale checker ignores comments and text literals', () => {
  const violations = scanSource(`
    // value.toLocaleString() uses en-US in the docs example.
    const example = "new Intl.DateTimeFormat('en-CA')";
  `, 'web/components/locale-fixture.tsx')
  assert.deepEqual(violations, [])
})
