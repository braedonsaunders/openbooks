import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// E2: staged attachments are orphaned when the queue handoff fails.
// deliverFlowEmail stages each attachment under a fresh random id BEFORE the
// Redis enqueue; the stub below stands in for that staging (no S3 in unit)
// while recording exactly which keys are deleted.
globalThis.__flowEmailStageTest = { deleted: [] }
const state = globalThis.__flowEmailStageTest

const sources = {
  '../delivery/email-attachments.ts': `
    export async function storeEmailAttachments(attachments) {
      return (attachments ?? []).map((a, i) => ({
        filename: a.filename,
        contentType: a.contentType,
        storageKey: 'staged-key-' + i,
      }));
    }
    export async function deleteStoredEmailAttachments(attachments) {
      globalThis.__flowEmailStageTest.deleted.push(
        ...(attachments ?? []).filter((a) => a.storageKey).map((a) => a.storageKey),
      );
    }
  `,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/outbox.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { deliverFlowEmail } = await import('./outbox.ts')
hooks.deregister()

function row(attachments) {
  return {
    id: 'row-1',
    org_id: 'org-1',
    kind: 'flow_email',
    subject_id: null,
    occurrence_key: 'k',
    attempt_count: 0,
    lease_token: 't',
    payload: {
      to: ['a@example.com'],
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
      attachments,
    },
  }
}

const attachment = (name) => ({
  filename: name,
  content: Buffer.from('bytes').toString('base64'),
  contentType: 'application/pdf',
})

test('a failing queue handoff deletes every ref staged in that attempt', async () => {
  state.deleted.length = 0
  await assert.rejects(
    deliverFlowEmail(
      row([attachment('a.pdf'), attachment('b.pdf')]),
      async () => { throw new Error('Redis unavailable') },
    ),
    /Redis unavailable/,
  )
  assert.deepEqual(state.deleted, ['staged-key-0', 'staged-key-1'])
})

test('a successful handoff keeps the staged refs for the worker to fetch', async () => {
  state.deleted.length = 0
  let sent
  await deliverFlowEmail(row([attachment('a.pdf')]), async (data) => { sent = data })
  assert.equal(sent.attachments.length, 1)
  assert.equal(sent.attachments[0].storageKey, 'staged-key-0')
  assert.deepEqual(state.deleted, [])
})
