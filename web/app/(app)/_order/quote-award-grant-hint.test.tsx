import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  act,
  buttonsContaining,
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'

// QA-042: on an approved estimate, a viewer with estimate grants but
// without the project-management grant sees Award disabled with the
// shared missing-grant hint — never silently absent. No preview fetch:
// nothing to decide with.
const { QuoteAwardAction } = await import('./QuoteAwardAction')
const React = await import('react')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

const QUOTE_ID = '77777777-7777-4777-8777-777777777777'

test('award renders disabled with a grant hint when the viewer cannot award', async (t) => {
  const fetched: string[] = []
  const restore = scriptFetch((url) => {
    fetched.push(url)
    return null
  })
  t.after(restore)
  function Host() {
    return <QuoteAwardAction quoteId={QUOTE_ID} docStatus="approved" canAward={false} />
  }
  const { unmount } = await mountDashboard(<Host />, messages)
  t.after(unmount)
  await tick()
  await act(async () => {})
  const awardButton = buttonsContaining('Award')[0]
  assert.ok(awardButton, 'the disabled award action renders')
  assert.equal((awardButton as HTMLButtonElement).disabled, true, 'the award stays disabled without the grant')
  assert.ok(
    !fetched.some((url) => url === `/api/estimates/${QUOTE_ID}/award`),
    'no preview fetch fires when there is nothing to decide with',
  )
  const text = document.body.textContent ?? ''
  assert.match(text, /projects\.manage/, 'the hint names the grant to ask for')
})
