import assert from 'node:assert/strict'
import test from 'node:test'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return{replace(){}}} export function usePathname(){return"/reports/trial-balance"} export function useSearchParams(){return new URLSearchParams("period=this_fiscal_year")}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { ReportFilterBar } = await import('./ReportFilterBar')

// F-t12-015 contract: the report toolbar (AS OF / period / Scheduled
// delivery / save / export) is ONE scrollable row — the actions render
// INSIDE the overflow-x-auto container, so a clipped action on a 390px
// viewport is reachable by horizontal scroll, never stranded. If the
// actions ever move outside that container, narrow-viewport actions
// become untappable and this test fails.
function toolbarHtml() {
  // The provider's overloads only accept children inside the props object.
  /* eslint-disable react/no-children-prop */
  return renderToString(
    React.createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: { reports: { filterBar: { asOf: 'AS OF', period: 'Period' } } },
      children: React.createElement(ReportFilterBar, {
        // Empty controls on purpose: the container + actions row render
        // unconditionally, and this keeps the test on ReportFilterBar's own
        // markup instead of the @openbooks/ui primitives (which resolve to
        // the main checkout via the worktree's symlinked node_modules).
        controls: { period: false },
        actions: React.createElement(
          React.Fragment,
          null,
          React.createElement('button', { type: 'button' }, 'Scheduled delivery'),
          React.createElement('button', { type: 'button' }, 'Save view'),
          React.createElement('button', { type: 'button' }, 'Export'),
        ),
      }),
    }),
  )
  /* eslint-enable react/no-children-prop */
}

test('F-t12-015: report actions render inside the scrollable toolbar row', () => {
  const html = toolbarHtml()
  const root = html.match(/^<div class="([^"]*)"/)
  assert.ok(root, 'toolbar must render a single root row')
  assert.match(root[1]!, /overflow-x-auto/, 'toolbar row must allow horizontal scroll')
  assert.match(root[1]!, /flex-nowrap/, 'toolbar keeps its single-row design')
  const scrollAt = html.indexOf('overflow-x-auto')
  const actionsAt = html.indexOf('ml-auto')
  const scheduledAt = html.indexOf('Scheduled delivery')
  assert.ok(actionsAt > scrollAt, 'actions wrapper must sit inside the scroll container')
  assert.ok(scheduledAt > actionsAt, 'Scheduled delivery must render inside the actions wrapper')
  assert.ok(html.includes('Save view') && html.includes('Export'), 'all actions must render')
})
