import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '../dashboard/_dashboard-render-harness'
import { act, mountDashboard } from '../dashboard/_dashboard-render-harness'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { TimesheetWeekJump } = await import('./TimesheetWeekJump')

const dir = dirname(fileURLToPath(import.meta.url));
const messages = {
  timesheets: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'timesheets.json'), 'utf8')),
  common: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'common.json'), 'utf8')),
  ui: JSON.parse(readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'ui.json'), 'utf8')),
};

function pushes(): string[] {
  return (globalThis as unknown as { __dashRouter: { pushes: string[] } }).__dashRouter.pushes
}

// The New-timesheet week jump preserves the shareable drawer id with the
// picked week snapped to its Sunday.

test('picking a date jumps the New-timesheet employee to its Sunday', async () => {
  const { unmount } = await mountDashboard(
    <TimesheetWeekJump basePath="/timesheets" employeeId="emp-1" />,
    messages,
  )
  try {
    const picker = document.querySelector('input[aria-label="Go to week"]') as HTMLInputElement | null
    assert.ok(picker, 'the jump offers a date input')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(picker, '2026-06-10')
      picker.dispatchEvent(new window.Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    assert.equal(pushes().length, 1, 'a valid picked date navigates once')
    assert.ok(
      pushes()[0]!.includes('timesheet=emp-1:2026-06-07'),
      `the jump preserves the drawer id on the snapped week, got ${JSON.stringify(pushes())}`,
    )
  } finally {
    await unmount()
  }
})
