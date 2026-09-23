import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = {
  handler: null,
  mode: 'sent',
  accepted: false,
  dunningSent: [],
  dunningFailed: [],
  emailFailed: 0,
  emailUncertain: 0,
  claimSentError: null,
}
globalThis.__dunningEmailTest = state

const sources = {
  bullmq: 'export class Worker { constructor(_queue, handler) { globalThis.__dunningEmailTest.handler = handler } }',
  '@openbooks/jobs': 'export const EMAIL_QUEUE = "test"; export const getBlockingConnection = () => ({}); export const resolveEmailDeliveryKey = () => "delivery-key";',
  '../delivery/email-attachments.ts': 'export const loadEmailAttachments = async () => []; export const deleteStoredEmailAttachments = async () => {};',
  '@openbooks/emails': `
    export const deriveEmailDeliveryKey = () => 'delivery';
    export const reconcileDeliveryAttempts = () => globalThis.__dunningEmailTest.accepted
      ? { action: 'complete', providerMessageId: 'prior-acceptance' } : { action: 'send' };
    export async function sendVia() {
      const state = globalThis.__dunningEmailTest;
      if (state.mode === 'fail') throw new Error('provider unavailable');
      if (state.mode === 'uncertain') return { kind: 'uncertain', reason: 'acceptance state unresolved: provider timeout' };
      return { kind: 'sent', providerMessageId: 'provider-1' };
    }
  `,
  '../platform/db.ts': 'export const db = { execute: async () => ({ rows: [] }) }; export const withOrgContext = (_org, action) => action();',
  '../organization/sandbox-guard.ts': 'export const isSandboxOrg = async () => false;',
  '../delivery/email-config.ts': `
    export const resolveOrgEmailTransport = async () => ({ provider: 'test' });
    export const claimEmailDeliveryLog = async () => ({ id: 'log', attempts: [] });
    export const appendEmailAttemptEvent = async () => [];
    export const confirmEmailSentGuarded = async () => true;
    export const markEmailFailed = async () => { globalThis.__dunningEmailTest.emailFailed++; };
    export const markEmailSent = async () => {};
    export const markEmailSuppressed = async () => {};
    export const markEmailUncertain = async () => { globalThis.__dunningEmailTest.emailUncertain++; };
    export const markPaymentRemittanceAttempt = async () => {};
    export const markPaymentRemittanceFailed = async () => {};
    export const markPaymentRemittanceSent = async () => {};
    export const markDunningClaimSent = async (_org, id) => { const s = globalThis.__dunningEmailTest; if (s.claimSentError) throw s.claimSentError; s.dunningSent.push(id); return true; };
    export const markDunningClaimFailed = async (_org, id, detail) => { globalThis.__dunningEmailTest.dunningFailed.push([id, detail]); return true; };
  `,
  '../delivery/report-delivery.ts': `
    export const markReportDeliveryFailed = async () => {};
    export const markReportDeliverySent = async () => {};
    export const markReportDeliveryStarted = async () => {};
    export const markReportDeliverySuppressed = async () => {};
  `,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/email-worker.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { createEmailWorker } = await import('./email-worker.ts')
createEmailWorker()
hooks.deregister()

function job({ attemptsMade = 0, attempts = 1, meta = { category: 'dunning', dunningLogId: 'claim-1' } } = {}) {
  return {
    id: 'dunning-job',
    attemptsMade,
    opts: { attempts },
    data: {
      orgId: 'org',
      to: 'billing@acme.test',
      subject: 'Reminder',
      html: '<p>Reminder</p>',
      text: 'Reminder',
      meta,
    },
  }
}

test('provider acceptance settles the staged dunning claim to sent', async () => {
  state.mode = 'sent'
  assert.deepEqual(await state.handler(job()), { id: 'provider-1' })
  assert.deepEqual(state.dunningSent, ['claim-1'])
  assert.deepEqual(state.dunningFailed, [])
})

test('a reconciled prior acceptance settles the claim without retransmission', async () => {
  state.accepted = true
  try {
    assert.deepEqual(await state.handler(job()), { id: 'prior-acceptance', reconciled: true })
    assert.deepEqual(state.dunningSent.at(-1), 'claim-1')
  } finally {
    state.accepted = false
  }
})

test('an exhausted rejection settles the claim failed with the provider detail', async () => {
  state.mode = 'fail'
  try {
    await assert.rejects(state.handler(job({ attempts: 1 })), /provider unavailable/)
    assert.deepEqual(state.dunningFailed.at(-1), ['claim-1', 'provider unavailable'])
    assert.equal(state.emailFailed, 1)
  } finally {
    state.mode = 'sent'
  }
})

test('a retryable rejection leaves the claim staged for the BullMQ retry', async () => {
  state.mode = 'fail'
  const failedBefore = state.dunningFailed.length
  try {
    await assert.rejects(state.handler(job({ attemptsMade: 0, attempts: 5 })), /provider unavailable/)
    assert.equal(state.dunningFailed.length, failedBefore, 'non-terminal failure must not settle the claim')
    assert.equal(state.emailFailed, 2)
  } finally {
    state.mode = 'sent'
  }
})

test('uncertain acceptance stays staged with the detail on the email row', async () => {
  state.mode = 'uncertain'
  const sentBefore = state.dunningSent.length
  const failedBefore = state.dunningFailed.length
  try {
    await assert.rejects(state.handler(job()), /acceptance state unresolved/)
    assert.equal(state.dunningSent.length, sentBefore, 'uncertainty must not mark the claim sent')
    assert.equal(state.dunningFailed.length, failedBefore, 'uncertainty must not mark the claim failed')
    assert.equal(state.emailUncertain, 1)
  } finally {
    state.mode = 'sent'
  }
})

test('a claim-settle fault after provider acceptance is bookkeeping, never a send failure', async () => {
  // The provider accepted the letter; only the staged→sent write threw (a
  // DB/trigger fault). Routing that into the send-failure catch recorded a
  // notSent event, marked the accepted email failed, and — once retries
  // exhausted — settled the claim failed while it stayed staged, so the next
  // tick re-armed it under a fresh delivery identity and sent the letter
  // twice. The fault must instead surface named, with no failure evidence,
  // leaving the email_log acceptance for reconciliation.
  state.claimSentError = new Error('claim settle write failed')
  const failedBefore = state.emailFailed
  const dunningFailedBefore = state.dunningFailed.length
  try {
    await assert.rejects(state.handler(job({ attempts: 1 })), (err) => {
      assert.equal(err.name, 'PostAcceptanceBookkeepingError')
      assert.match(err.message, /post-acceptance bookkeeping failed/)
      assert.match(err.message, /claim settle write failed/)
      return true
    })
    assert.equal(state.emailFailed, failedBefore, 'acceptance must never record a send failure')
    assert.equal(state.dunningFailed.length, dunningFailedBefore, 'acceptance must never settle the claim failed')
  } finally {
    state.claimSentError = null
  }
})

test('mail without a dunning claim settles nothing', async () => {
  const sentBefore = state.dunningSent.length
  const failedBefore = state.dunningFailed.length
  await state.handler(job({ meta: { category: 'dunning' } }))
  assert.equal(state.dunningSent.length, sentBefore)
  assert.equal(state.dunningFailed.length, failedBefore)
})
