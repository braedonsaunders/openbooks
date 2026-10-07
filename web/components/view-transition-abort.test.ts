import assert from 'node:assert/strict'
import test from 'node:test'
import { installViewTransitionAbortFilter, isBenignViewTransitionAbort } from './view-transition-abort.ts'

function invalidState(message: string) {
  return Object.assign(new Error(message), { name: 'InvalidStateError' })
}

/** Dispatches a reported error at `target` and returns what a later listener saw. */
function report(target: EventTarget, error: unknown) {
  const seen: unknown[] = []
  const listener = (event: Event) => seen.push((event as Event & { error?: unknown }).error)
  target.addEventListener('error', listener)
  const event = Object.assign(new Event('error', { cancelable: true }), { error })
  target.dispatchEvent(event)
  target.removeEventListener('error', listener)
  return { seen, defaultPrevented: event.defaultPrevented }
}

test('an abort for a resized viewport, in the wording React does not recognise, never reaches the error handlers', () => {
  const target = new EventTarget()
  installViewTransitionAbortFilter(target)
  const result = report(target, invalidState('Transition was aborted because of invalid state. Viewport size changed'))
  assert.deepEqual(result.seen, [], 'the skipped animation must not surface as an uncaught error')
  assert.equal(result.defaultPrevented, true, 'the browser must not log the skipped animation either')
})

test('every other error, including an unrelated InvalidStateError, still reaches the error handlers', () => {
  const target = new EventTarget()
  installViewTransitionAbortFilter(target)
  const unrelated = invalidState('The object is in an invalid state.')
  const failure = new Error('Transition was aborted because of invalid state')
  for (const error of [unrelated, failure, 'plain string', null]) {
    const result = report(target, error)
    assert.deepEqual(result.seen, [error], `a real error must be reported: ${String((error as Error | null)?.message ?? error)}`)
    assert.equal(result.defaultPrevented, false)
  }
})

test('the filter recognises each skip and abort the browser reports for layout or visibility', () => {
  for (const message of [
    'Transition was aborted because of invalid state',
    'Skipping view transition because viewport size changed.',
    'Skipping view transition because document visibility state has become hidden.',
    'View transition was skipped because document visibility state is hidden.',
  ]) {
    assert.equal(isBenignViewTransitionAbort(invalidState(message)), true, message)
  }
})
