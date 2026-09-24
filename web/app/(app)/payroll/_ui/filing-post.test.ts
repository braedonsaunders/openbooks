import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fetchFilingLifecycle,
  fetchFilingSlip,
  postFilingCorrection,
} from './filing-amendments'
import { recordFilingOriginal } from './filing-workspace'
import { discardParallelRegister } from '../parallel-run/ParallelRunView'

// F3-20 (record-as-filed), F3-21 (amendment preview/issue), F3-23 (parallel
// register discard), and the slip-drawer / lifecycle fetches: every one
// parsed the response body BEFORE checking the status, so a non-JSON error
// body threw a SyntaxError and the operator read a parse error instead of
// the server's refusal. Each now checks the status first through the
// canonical client helper. Driven through the extracted fetch functions
// with scripted fetches — no source text is read.
function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): () => void {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
    responder(String(input), init)) as typeof fetch
  return () => {
    globalThis.fetch = prior
  }
}

const section = { country: 'CA', key: 't4', data: { rows: [], rowKey: 'id' } } as unknown as Parameters<
  typeof recordFilingOriginal
>[0]

test('record-as-filed: a non-JSON 502 surfaces the fallback with the status', async () => {
  const restore = stubFetch(
    () => new Response('<html>proxy page</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
  )
  try {
    await assert.rejects(
      recordFilingOriginal(section, 2026, 'filed'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'the filing could not be recorded (status 502)')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('record-as-filed: a named refusal surfaces, and a file refusal returns instead of throwing', async () => {
  let restore = stubFetch(() => Response.json({ error: 'the year is not open' }, { status: 422 }))
  try {
    await assert.rejects(recordFilingOriginal(section, 2026, 'filed'), /the year is not open/)
  } finally {
    restore()
  }
  restore = stubFetch(() => Response.json({ fileRefusal: 'no electronic file is declared' }))
  try {
    assert.equal(await recordFilingOriginal(section, 2026, 'filed'), 'no electronic file is declared')
  } finally {
    restore()
  }
})

test('slip fetch: a non-JSON 502 surfaces the fallback with the status', async () => {
  const restore = stubFetch(() => new Response(null, { status: 502 }))
  try {
    await assert.rejects(
      fetchFilingSlip('/api/payroll/year-end/slip?country=CA'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'the slip could not be loaded (status 502)')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('slip fetch: a body without a slip is refused by name', async () => {
  const restore = stubFetch(() => Response.json({ error: 'the row is not in the population' }))
  try {
    await assert.rejects(fetchFilingSlip('/api/payroll/year-end/slip?country=CA'), /not in the population/)
  } finally {
    restore()
  }
})

test('lifecycle fetch: a non-JSON 500 surfaces the fallback with the status', async () => {
  const restore = stubFetch(
    () => new Response('<html>proxy page</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
  )
  try {
    await assert.rejects(
      fetchFilingLifecycle('CA', 't4', 2026),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'the filing history could not be loaded (status 500)')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('issue correction: a named refusal surfaces, and a file refusal returns instead of throwing', async () => {
  let restore = stubFetch(() => Response.json({ error: 'the slip has not changed' }, { status: 422 }))
  const input = {
    country: 'CA',
    filing: 't4',
    year: 2026,
    revision: 'amended' as const,
    rowIds: ['row-1'],
  }
  try {
    await assert.rejects(postFilingCorrection(input), /has not changed/)
  } finally {
    restore()
  }
  restore = stubFetch(() => Response.json({ fileRefusal: 'no correction file is declared' }))
  try {
    assert.equal(await postFilingCorrection(input), 'no correction file is declared')
  } finally {
    restore()
  }
})

test('discard register: a non-JSON 502 surfaces the fallback with the status', async () => {
  const restore = stubFetch(() => new Response(null, { status: 502 }))
  try {
    await assert.rejects(
      discardParallelRegister('reg-1'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'could not discard the register (status 502)')
        return true
      },
    )
  } finally {
    restore()
  }
})
