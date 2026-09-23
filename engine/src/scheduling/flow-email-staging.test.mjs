import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { buildEmailJobs } from '../../../packages/jobs/src/queues/email.ts'

// DS1/E2: staged attachments are orphaned when the queue handoff fails.
// DS2: the DS1 catch deleted staged refs on ANY enqueue exception — but a
// Redis/BullMQ add can accept the job and then lose its reply, so the job
// exists while the enqueue throws, and the queued worker later refuses the
// missing blob. deliverFlowEmail stages each attachment under a fresh random
// id BEFORE the Redis enqueue; the stub below stands in for that staging (no
// S3 in unit) while recording exactly which keys stay live. The settlement
// helper itself is REAL (not stubbed): its static './email-attachments.ts'
// import is served the same tracking stub whenever the importing parent is
// the settlement module, and its dynamic '@openbooks/jobs' import reaches
// the real package, so the expected job identities under test are the
// production fanout plan, not a copy. The multi-recipient tests below use
// the REAL buildEmailJobs to record accepted jobs — never a reimplementation
// — so a settlement that checked only the base id (instead of the
// per-recipient fanout ids) would fail them.
globalThis.__flowEmailStageTest = { stagedCount: 0, live: new Set(), deleted: [], recorded: new Map() }
const state = globalThis.__flowEmailStageTest

const emailAttachmentsStub = `
    export async function storeEmailAttachments(attachments) {
      const s = globalThis.__flowEmailStageTest;
      return (attachments ?? []).map((a) => {
        const key = 'staged-key-' + (s.stagedCount++);
        s.live.add(key);
        return { filename: a.filename, contentType: a.contentType, storageKey: key };
      });
    }
    export async function deleteStoredEmailAttachments(attachments) {
      const s = globalThis.__flowEmailStageTest;
      for (const a of attachments ?? []) {
        if (a.storageKey) { s.live.delete(a.storageKey); s.deleted.push(a.storageKey); }
      }
    }
  `

const sources = {
  '../delivery/email-attachments.ts': emailAttachmentsStub,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  const parent = context.parentURL ?? ''
  if (specifier === './email-attachments.ts' && parent.endsWith('/email-enqueue-settlement.ts')) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(emailAttachmentsStub)}` }
  }
  if (parent.endsWith('/outbox.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { deliverFlowEmail } = await import('./outbox.ts')
hooks.deregister()

function row(attachments, to = ['a@example.com']) {
  return {
    id: 'row-1',
    org_id: 'org-1',
    kind: 'flow_email',
    subject_id: null,
    occurrence_key: 'k',
    attempt_count: 0,
    lease_token: 't',
    payload: {
      to,
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

function reset() {
  state.stagedCount = 0
  state.live.clear()
  state.deleted.length = 0
  state.recorded.clear()
}

// The queue-state probe the tests inject: the fake queue's recorded jobs.
const probeQueuedJob = async (jobId) => state.recorded.get(jobId) ?? null

// Faithful to BullMQ's add(): record the exact jobs the real plan derives
// (base id for one recipient, per-recipient fanout ids for several), then
// lose the acknowledgement.
function recordThenThrow(data, options) {
  for (const job of buildEmailJobs(data, { jobId: options.jobId })) {
    state.recorded.set(job.opts.jobId, job.data)
  }
  throw new Error('Redis connection lost after accept')
}

test('provable non-acceptance: a failed handoff with no queued job deletes every ref staged in that attempt', async () => {
  reset()
  await assert.rejects(
    deliverFlowEmail(
      row([attachment('a.pdf'), attachment('b.pdf')]),
      async () => { throw new Error('Redis unavailable') },
      { probeQueuedJob },
    ),
    /Redis unavailable/,
  )
  assert.equal(state.live.size, 0)
  assert.deepEqual([...state.deleted].sort(), ['staged-key-0', 'staged-key-1'])
})

test('lost acknowledgement: an enqueue that records the jobs then throws keeps the blobs for the queued workers', async () => {
  reset()
  // Two recipients: the accepted jobs carry per-recipient fanout ids, not
  // the base row id — the settlement must resolve those, not just the base.
  await deliverFlowEmail(
    row([attachment('a.pdf')], ['a@example.com', 'b@example.com']),
    recordThenThrow,
    { probeQueuedJob },
  )
  // Reported as success: the drain marks the row succeeded, no retry.
  // The blobs are kept, and each recorded job's worker can still read its
  // refs: every ref the recorded jobs carry is still live.
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
  assert.equal(state.recorded.size, 2)
  for (const recorded of state.recorded.values()) {
    assert.equal(recorded.attachments.length, 1)
    assert.ok(state.live.has(recorded.attachments[0].storageKey))
  }
})

test('partial acceptance: some jobs queued keeps every blob and rethrows for the retry', async () => {
  reset()
  // Only the first fanout job was accepted before the connection dropped.
  await assert.rejects(
    deliverFlowEmail(
      row([attachment('a.pdf')], ['a@example.com', 'b@example.com']),
      (data, options) => {
        const jobs = buildEmailJobs(data, { jobId: options.jobId })
        assert.equal(jobs.length, 2)
        state.recorded.set(jobs[0].opts.jobId, jobs[0].data)
        throw new Error('Redis connection lost mid-add')
      },
      { probeQueuedJob },
    ),
    /Redis connection lost mid-add/,
  )
  // The live job still needs its refs, and the missing recipient still
  // needs a retry (which re-adds the same deterministic ids, collapsing
  // onto the live job) — so nothing is deleted.
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
})

test('uncheckable queue: when the queue cannot be reached the blobs are kept and the error is rethrown', async () => {
  reset()
  await assert.rejects(
    deliverFlowEmail(
      row([attachment('a.pdf')]),
      async () => { throw new Error('Redis unavailable') },
      { probeQueuedJob: async () => { throw new Error('cannot reach Redis for the check') } },
    ),
    /Redis unavailable/,
  )
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
})

test('a successful handoff keeps the staged refs for the worker to fetch', async () => {
  reset()
  let sent
  await deliverFlowEmail(row([attachment('a.pdf')]), async (data) => { sent = data })
  assert.equal(sent.attachments.length, 1)
  assert.equal(sent.attachments[0].storageKey, 'staged-key-0')
  assert.ok(state.live.has('staged-key-0'))
  assert.deepEqual(state.deleted, [])
})
