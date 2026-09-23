import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// E3: partial staging is rolled back. storeEmailAttachments writes one
// object per attachment; when the 2nd (or later) write fails, the keys
// already written in that call must be deleted before rethrowing — the
// caller never receives the partial refs, so nothing else can clean them.
// The stub below stands in for object storage (no S3 in unit) with a real
// key→bytes map, so the test observes actual orphan state, not call counts.
globalThis.__attachmentRollbackTest = { objects: new Map(), failAfterPuts: null }
const state = globalThis.__attachmentRollbackTest

const sources = {
  '../platform/file-storage.ts': `
    export const s3Enabled = true;
    export async function putEmailAttachmentBlob(id, bytes, contentType) {
      const s = globalThis.__attachmentRollbackTest;
      if (s.failAfterPuts !== null && s.objects.size >= s.failAfterPuts) {
        throw new Error('S3 unavailable');
      }
      s.objects.set(id, { bytes, contentType });
    }
    export async function getEmailAttachmentBlob(id) {
      return globalThis.__attachmentRollbackTest.objects.get(id)?.bytes ?? null;
    }
    export async function deleteEmailAttachmentBlobs(ids) {
      for (const id of ids) globalThis.__attachmentRollbackTest.objects.delete(id);
    }
  `,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/email-attachments.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { storeEmailAttachments } = await import('./email-attachments.ts')
hooks.deregister()

const payload = (name, content) => ({
  filename: name,
  content: Buffer.from(content).toString('base64'),
  contentType: 'application/pdf',
})

test('a failed second write deletes the first key and stores nothing', async () => {
  state.objects.clear()
  state.failAfterPuts = 1
  try {
    await assert.rejects(
      storeEmailAttachments([payload('a.pdf', 'first'), payload('b.pdf', 'second')]),
      /S3 unavailable/,
    )
    assert.equal(state.objects.size, 0, 'no partial blob may survive the failed staging')
  } finally {
    state.failAfterPuts = null
  }
})

test('a successful staging keeps every blob', async () => {
  state.objects.clear()
  const stored = await storeEmailAttachments([payload('a.pdf', 'first'), payload('b.pdf', 'second')])
  assert.equal(stored.length, 2)
  assert.equal(state.objects.size, 2)
  for (const ref of stored) {
    assert.ok(ref.storageKey)
    assert.ok(state.objects.has(ref.storageKey))
  }
})
