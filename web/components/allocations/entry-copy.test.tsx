import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../../testing/jsdom-env.ts'

const { registerHooks } = await import('node:module')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
await bootJsdomEnvironment({ url: "http://localhost:4800/", matchMediaMatches: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') return { shortCircuit: true, url: worktreeUi }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../messages/en')).default
const { DistributionDialog } = await import('./DistributionDialog')

async function renderDialog(candidatesFailed: boolean): Promise<string> {
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <NextIntlClientProvider
          locale="en"
          messages={messages}
          timeZone="UTC"
          onError={(error) => { throw error }}
        >
          <DistributionDialog
            open
            lineAmount="125.00"
            candidates={[]}
            candidatesFailed={candidatesFailed}
            accountOptions={[]}
            codings={[]}
            initialRuleKey={null}
            onClose={() => {}}
            onApplyRule={() => {}}
            onApplyChildren={() => {}}
          />
        </NextIntlClientProvider>,
      )
    })
    return document.body.textContent ?? ''
  } finally {
    await act(async () => root.unmount())
  }
}

test('entry split dialog shows the rule-load refusal and hand-edit guidance', async () => {
  const text = await renderDialog(true)

  assert.match(text, /Split line 125\.00/)
  assert.match(text, /Could not load distribution rules\./)
  assert.match(text, /Hand-entered children are locked against re-explosion\./)
  assert.match(text, /Apply/)
  assert.match(text, /Cancel/)
  assert.doesNotMatch(text, /allocations\./)
})

test('entry split dialog explains when no distribution rule matches', async () => {
  const text = await renderDialog(false)

  assert.match(text, /No entry rules match this line\./)
  assert.doesNotMatch(text, /Could not load distribution rules\./)
  assert.doesNotMatch(text, /allocations\./)
})
