import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../dashboard/_dashboard-render-harness'
import { act, click, mountDashboard, scriptFetch } from '../../dashboard/_dashboard-render-harness'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { LinkPersonButton } = await import('./UserActions')

const dir = dirname(fileURLToPath(import.meta.url));
const messages = {
  admin: JSON.parse(readFileSync(join(dir, '..', '..', '..', '..', 'messages', 'en', 'admin.json'), 'utf8')),
  common: JSON.parse(readFileSync(join(dir, '..', '..', '..', '..', 'messages', 'en', 'common.json'), 'utf8')),
  ui: JSON.parse(readFileSync(join(dir, '..', '..', '..', '..', 'messages', 'en', 'ui.json'), 'utf8')),
};

// Saving Link person without the attestation must refuse ON the checkbox:
// focus lands there and the control highlights until it is checked, so the
// requirement cannot be missed a second time.

function buttonNamed(name: string): HTMLButtonElement | null {
  return [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  ) as HTMLButtonElement | null
}

async function fillReason(): Promise<void> {
  const reason = document.querySelector('#link-person-reason') as HTMLTextAreaElement | null
  assert.ok(reason, 'the drawer asks for a reason')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(reason, 'Verified against the HR roster')
    reason.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('refusing without attestation focuses and highlights the checkbox', async () => {
  const restoreFetch = scriptFetch((url) =>
    url.includes('/api/admin/users') ? Response.json({ options: [], selected: null }) : null,
  )
  const { unmount } = await mountDashboard(
    <LinkPersonButton userId="user-1" userName="Robin" partyId={null} partyName={null} isSelf={false} />,
    messages,
  )
  try {
    await click(buttonNamed('Link person')!)
    const checkbox = document.querySelector('#link-person-attest') as HTMLInputElement | null
    assert.ok(checkbox, 'the drawer renders the attestation checkbox')
    await fillReason()
    await click(buttonNamed('Save link')!)

    const alert = document.querySelector('[role="alert"]')
    assert.ok(alert, 'the refusal surfaces inline')
    assert.match(alert.textContent ?? '', /Explicit attestation is required/)
    assert.equal(document.activeElement, checkbox, 'focus lands on the attestation checkbox')
    assert.equal(checkbox.getAttribute('aria-invalid'), 'true', 'the checkbox is marked invalid')
    const row = checkbox.closest('div')
    assert.ok(row?.className.includes('ring-rose-400'), 'the attestation row highlights the miss')
    assert.equal(row?.firstElementChild, checkbox, 'the checkbox leads the attestation row')
    assert.equal(
      checkbox.getAttribute('aria-describedby'),
      'link-person-error',
      'the checkbox points at the refusal text',
    )

    await click(checkbox)
    assert.equal(checkbox.getAttribute('aria-invalid'), 'false', 'checking clears the invalid mark')
    assert.ok(!row?.className.includes('ring-rose-400'), 'checking clears the highlight')
  } finally {
    await unmount()
    restoreFetch()
  }
})
