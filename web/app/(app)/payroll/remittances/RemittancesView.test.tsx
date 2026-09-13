import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./RemittancesView.tsx', import.meta.url), 'utf8')

// Exercise the real client view: a refusal must never look like a zero balance.
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return {
      shortCircuit: true,
      url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}',
    }
    return next(specifier, context)
  },
})
const React = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('../../../../components/money-provider')
const { RemittancesView } = await import('./RemittancesView')
const messages = JSON.parse(readFileSync(new URL('../../../../messages/en/payroll.json', import.meta.url), 'utf8'))
Object.assign(globalThis, { React })

test('remittance bill payload follows edited dates while preserving unchanged range values', () => {
  assert.match(source, /const \[range, setRange\] = useState\(\{ from, to \}\)/)
  assert.match(source, /value=\{range\.from\}[\s\S]*?from: e\.target\.value/)
  assert.match(source, /value=\{range\.to\}[\s\S]*?to: e\.target\.value/)

  const payload = source.match(/body: JSON\.stringify\(\{([\s\S]*?)\n        \}\),/)?.[1]
  assert.ok(payload, 'create-bill must serialize a request payload')
  assert.match(payload, /from: range\.from/)
  assert.match(payload, /to: range\.to/)
  assert.doesNotMatch(payload, /^\s*from,\s*$/m)
  assert.doesNotMatch(payload, /^\s*to,\s*$/m)
})

test('refused remittance view renders an alert and date form, without an empty balance or bill action', () => {
  const message = 'Committed payroll has an unknown historical filing account.'
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en-CA" timeZone="UTC" messages={{ payroll: messages }}>
      <MoneyProvider currency="CAD">
        <RemittancesView groups={[]} from="2026-08-01" to="2026-08-31" canCreate={false} populationRefusal={message} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  assert.ok(html.includes(message))
  assert.ok(html.includes('role="alert"'))
  assert.ok(html.includes('action="/payroll/remittances"'))
  assert.ok(html.includes('value="2026-08-01"'))
  assert.ok(html.includes('value="2026-08-31"'))
  assert.ok(!html.includes(messages.remittances.empty))
  assert.ok(!html.includes(messages.remittances.createBill))
})
