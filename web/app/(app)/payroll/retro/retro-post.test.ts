import assert from 'node:assert/strict'
import test from 'node:test'
import { postRetroAction } from './RetroWorkspace'

// F3-2: the retro propose/create call parsed the response body BEFORE
// checking the status, so a non-JSON error body threw a SyntaxError and the
// operator read a parse error instead of the failure. The status is now
// checked first through the canonical client helper.
function stubFetch(responder: () => Response | Promise<Response>): () => void {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => responder()) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

test('a non-JSON 502 surfaces the fallback with the status, never a SyntaxError', async () => {
  const restore = stubFetch(
    () => new Response('<html><body>Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  )
  try {
    await assert.rejects(
      postRetroAction('propose', { payScheduleId: 'schedule-1', payDate: '2026-09-30' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'the retro request failed (status 502)')
        assert.doesNotMatch(error.message, /JSON|SyntaxError|json/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a named 422 refusal surfaces the server message', async () => {
  const restore = stubFetch(
    () => Response.json({ error: 'the pay period is closed' }, { status: 422 }),
  )
  try {
    await assert.rejects(
      postRetroAction('create', { payScheduleId: 'schedule-1', payDate: '2026-09-30' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'the pay period is closed')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a successful propose returns the proposal body', async () => {
  const restore = stubFetch(() => Response.json({ taxYear: 2026, periods: [] }))
  try {
    assert.deepEqual(
      await postRetroAction('propose', { payScheduleId: 'schedule-1', payDate: '2026-09-30' }),
      { taxYear: 2026, periods: [] },
    )
  } finally {
    restore()
  }
})
