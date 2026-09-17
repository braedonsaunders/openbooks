import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t09-016: a computed tax filing offered Compute/Export only — Save lived
// inside the Export dropdown, so testers never found it, the filings
// history stayed empty, and mark-filed stayed unreachable. Save is a
// first-class button beside Export on the computed card, not a menu item.
const source = readFileSync(new URL('./TaxFilingsView.tsx', import.meta.url), 'utf8')

test('the computed filing offers save as a first-class button beside export', () => {
  const popover = source.slice(source.indexOf('<Popover'), source.indexOf('</Popover>'))
  assert.doesNotMatch(popover, /saveSnapshot/, 'save must not hide inside the export menu')
  assert.match(source, /<Button[^>]*onClick=\{\(\) => void saveSnapshot\(\)\}/)
})
