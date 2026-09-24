import assert from 'node:assert/strict'
import test from 'node:test'
import { postRun } from './NewRunButton'

// F3-1: creating a pay run parsed the response body BEFORE checking the
// status, so a non-JSON error body (a proxy page, an empty 502) threw a
// SyntaxError out of postRun and the operator read a parse error instead of
// the failure. The status is now checked first through the canonical client
// helper: a named refusal surfaces, otherwise the fallback with the status.
function stubFetch(responder: () => Response | Promise<Response>): () => void {
  const prior = globalThis.fetch
  globalThis.fetch = (async () => responder()) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

test('a non-JSON 502 surfaces the localized fallback with the status, never a SyntaxError', async () => {
  const restore = stubFetch(
    () => new Response('<html><body>Bad Gateway</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  )
  try {
    await assert.rejects(
      postRun({ payScheduleId: 'schedule-1' }, 'Impossible de créer la paie.'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Impossible de créer la paie. (status 502)')
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
    () => Response.json({ error: 'the period overlaps an existing run' }, { status: 422 }),
  )
  try {
    await assert.rejects(
      postRun({ payScheduleId: 'schedule-1' }, 'Échec de création.'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'the period overlaps an existing run')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a successful create returns the document id', async () => {
  const restore = stubFetch(() => Response.json({ documentId: 'doc-9' }))
  try {
    assert.equal(await postRun({ payScheduleId: 'schedule-1' }, 'Échec de création.'), 'doc-9')
  } finally {
    restore()
  }
})

test('a malformed success body uses the localized failure message', async () => {
  const restore = stubFetch(() => Response.json({ ok: true }))
  try {
    await assert.rejects(
      postRun({ payScheduleId: 'schedule-1' }, 'Impossible de créer la paie.'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'Impossible de créer la paie. (status 200)')
        return true
      },
    )
  } finally {
    restore()
  }
})
