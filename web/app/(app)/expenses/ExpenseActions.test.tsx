import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost/expenses', scrollIntoView: false, resizeObserver: false })
Object.assign(globalThis, {
  __expenseActionTest: { errors: [] as string[], refreshes: 0 },
  IS_REACT_ACT_ENVIRONMENT: true,
})
const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return {refresh(){globalThis.__expenseActionTest.refreshes++}}}' })
registerHooks({
  resolve(specifier, context, next) {

    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(){},error(message){globalThis.__expenseActionTest.errors.push(message)}}' }
    }
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: 'data:text/javascript,export default function Link(props){return props.children}' }
    }
    return next(specifier, context)
  },
})

const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { ExpenseActions } = await import('./ExpenseActions')

test('a non-JSON API refusal is translated and releases the row action', async (t) => {
  const state = (globalThis as Record<string, unknown>).__expenseActionTest as {
    errors: string[]
    refreshes: number
  }
  const priorFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('<html>upstream unavailable</html>', { status: 502 })
  t.after(() => { globalThis.fetch = priorFetch })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  t.after(() => { act(() => root.unmount()); host.remove() })

  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ExpenseActions id="expense-1" status="draft" canSubmit canPost={false} openHref="/expenses/expense-1" />
      </NextIntlClientProvider>,
    )
  })
  const button = host.querySelector('button')!
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 20)) })

  assert.equal(state.errors.at(-1), 'Action failed (status 502)')
  assert.equal(host.querySelector('button')?.disabled, false)
  assert.equal(state.refreshes, 0)
})
