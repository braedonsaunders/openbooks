import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { DrawerTabStrip } = await import('./drawer-tab-strip.tsx')

// The shared strip renders one level of tab buttons in house style: the rail
// and the payroll sub-tabs are the same primitive, not two tab looks.
test('the strip renders every tab with the active one selected', () => {
  const html = renderToStaticMarkup(
    <DrawerTabStrip
      tabs={[
        { key: 'general', label: 'General' },
        { key: 'tax', label: 'Tax and withholding' },
      ]}
      activeKey="tax"
      onSelect={() => {}}
      ariaLabel="Payroll sections"
    />,
  )
  assert.match(html, /<nav[^>]*aria-label="Payroll sections"/)
  assert.match(html, /role="tab"/)
  assert.match(html, />General</)
  assert.match(html, />Tax and withholding</)
  assert.match(html, /aria-selected="true"[^>]*>Tax and withholding</)
  assert.match(html, /aria-selected="false"[^>]*>General</)
})
