import assert from 'node:assert/strict'
import test from 'node:test'
import '../dashboard/_dashboard-render-harness'
import {
  act,
  buttonsContaining,
  click,
  mountDashboard,
  scriptFetch,
  tick,
} from '../dashboard/_dashboard-render-harness'

// Real award path: estimate drawer > actions popover > Award drawer >
// project-type combobox > submit. Fetch is the only scripted boundary.
const { QuoteAwardAction } = await import('./QuoteAwardAction')
const { Drawer } = await import('@openbooks/ui')
const { Popover } = await import('@openbooks/ui')
const { Button } = await import('@openbooks/ui')
const React = await import('react')
const messages = (await import('../../../messages/en')).default as Record<string, unknown>

// The shared Select completes a pick by dispatching a genuine change event;
// jsdom only accepts its own realm's Event for that dispatch.
globalThis.Event = window.Event as typeof Event

const QUOTE_ID = '11111111-1111-4111-8111-111111111111'
const TYPE_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'

function preview() {
  return {
    quote: { id: QUOTE_ID, documentNumber: 'QE-100', status: 'approved', customerName: 'Acme', projectId: null, projectName: null },
    awarded: null,
    blocked: null,
    defaults: { mode: 'new', projectId: null, name: 'Acme — QE-100', projectTypeId: null, contractValue: null },
    projectTypes: [{ id: TYPE_ID, key: 'fixed_price', name: 'Fixed price', pricesFromContract: false }],
    projects: [],
    existingTasks: [],
    productionQuantitiesAvailable: false,
    lines: [
      {
        lineId: '44444444-4444-4444-8444-444444444444',
        lineNumber: 1,
        description: 'Install',
        itemId: null,
        itemName: null,
        itemKind: null,
        itemUnit: null,
        unit: 'hr',
        quantity: '10',
        amount: '1000.00',
        costAmount: '600.00',
        itemDefaultCost: null,
        fxRate: '1',
      },
    ],
    plan: null,
    planError: null,
  }
}

test('award from the estimate drawer picks a project type and creates the project', async (t) => {
  // Desktop viewport so the combobox renders its anchored listbox.
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
  const posts: { url: string; body: unknown }[] = []
  const restore = scriptFetch((url, init) => {
    if (url === `/api/estimates/${QUOTE_ID}/award` && !init?.method) return Response.json(preview())
    if (url === `/api/estimates/${QUOTE_ID}/award` && init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) })
      return Response.json({ projectId: PROJECT_ID, created: true }, { status: 201 })
    }
    return null
  })
  t.after(restore)
  function Host() {
    const [actionsOpen, setActionsOpen] = React.useState(false)
    return (
      <Drawer open onClose={() => {}} title="Estimate QE-100">
        <Popover
          open={actionsOpen}
          onOpenChange={setActionsOpen}
          trigger={<Button onClick={() => setActionsOpen((o) => !o)}>Actions</Button>}
        >
          <div>
            <QuoteAwardAction quoteId={QUOTE_ID} docStatus="approved" />
          </div>
        </Popover>
      </Drawer>
    )
  }
  const { unmount } = await mountDashboard(<Host />, messages)
  t.after(unmount)
  await tick()
  await click(buttonsContaining('Actions')[0]!)
  await tick()
  const awardButton = buttonsContaining('Award')[0]
  assert.ok(awardButton, 'the award action renders in the estimate drawer')
  await click(awardButton)
  await tick()
  const awardDialogs = [...document.querySelectorAll('aside[role="dialog"]')]
  assert.equal(awardDialogs.length, 2, 'the award drawer opens over the estimate drawer')
  const trigger = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Fixed price') || (b.textContent ?? '').includes('No project') || (b.textContent ?? '').includes('type'))
  assert.ok(trigger, `the project-type combobox renders (buttons: ${[...document.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')})`)
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  const overlay = document.querySelector('[data-ui-overlay]')
  assert.ok(overlay, 'the combobox listbox opens')
  const option = [...document.querySelectorAll('[role="option"]')].find((o) => (o.textContent ?? '').includes('Fixed price'))
  assert.ok(option, 'the project type option renders')
  await click(option)
  await tick()
  assert.equal(posts.length, 0, 'picking a type posts nothing yet')
  assert.equal(document.querySelectorAll('aside[role="dialog"]').length, 2, 'the pick dismisses no drawer')
  // A missed press on the award backdrop while the picker is open belongs
  // to the picker: the listbox closes, the dialog and every entry survive.
  const reopened = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Fixed price')
  assert.ok(reopened, 'the pick lands on the trigger')
  await act(async () => {
    reopened.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    reopened.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    reopened.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  assert.ok(document.querySelector('[data-ui-overlay]'), 'the listbox reopens')
  const awardBackdrop = document.querySelector('[data-drawer-depth="1"] > [aria-hidden="true"]')
  assert.ok(awardBackdrop, 'the award drawer renders its backdrop')
  await act(async () => {
    awardBackdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    awardBackdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    awardBackdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  assert.equal(document.querySelector('[data-ui-overlay]'), null, 'the missed press closes only the picker')
  assert.equal(document.querySelectorAll('aside[role="dialog"]').length, 2, 'the award dialog stays mounted through the missed press')
  assert.equal(
    document.querySelector('[data-drawer-depth="1"]')?.hasAttribute('data-overlay-exiting') ?? null,
    false,
    'the award dialog is not closing after the missed press',
  )
  assert.equal(
    (document.querySelector('input[value="Acme — QE-100"]') as HTMLInputElement | null)?.value,
    'Acme — QE-100',
    'entered values survive the missed press',
  )
  const submit = buttonsContaining('Award and create project')[0]
  assert.ok(submit, `the award submit renders (disabled=${submit?.disabled})`)
  await click(submit)
  await tick()
  await tick()
  assert.equal(posts.length, 1, 'submitting posts the award once')
  assert.equal((posts[0]!.body as { target: { projectTypeId: string } }).target.projectTypeId, TYPE_ID, 'the picked type reaches the award')
  assert.deepEqual(globalThis.__dashRouter.pushes, [`/projects?project=${encodeURIComponent(PROJECT_ID)}`], 'success navigates to the new project')
})
