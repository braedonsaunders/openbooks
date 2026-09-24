import assert from 'node:assert/strict'
import test from 'node:test'

// F2-14b (AP pay-run planner): due dates must render in the viewer's locale.
// A French viewer sees "5 janv.", never the pinned English "Jan 5".
const React = await import('react')
Object.assign(globalThis, { React })
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){},back(){},prefetch(){}}}',
      }
    }
    return next(specifier, context)
  },
})
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('@/components/money-provider')
const { PayRunPlanner } = await import('./PayRunPlanner')

const entry = {
  id: 'e1',
  docId: 'd1',
  docKind: 'vendor_bill',
  partyName: 'Acme',
  amount: '1250.0000',
  dueDate: '2026-01-05',
  daysOverdue: 3,
  method: 'check',
}

function markup(locale: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{}} timeZone="UTC">
      <MoneyProvider currency="USD">
        <PayRunPlanner
          recommended={[entry]}
          capacity={null}
          startingCash="0.0000"
          restrictToSafe={false}
          deferredThisWeek="0.0000"
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

test('pay-run due dates render in the viewer locale (F2-14b)', () => {
  assert.match(markup('en-US'), /Jan 5/)
  assert.match(markup('fr'), /janv/i)
  assert.ok(!markup('fr').includes('Jan 5'), 'no pinned English date may leak into the French render')
})
