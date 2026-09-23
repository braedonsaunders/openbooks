import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = {
  handler: null,
  sent: 0,
  sendError: null,
  remittanceAttempts: [],
  remittanceSent: [],
  remittanceFailed: [],
}
globalThis.__paymentRemittanceEmailTest = state

const sources = {
  bullmq: 'export class Worker { constructor(_queue, handler) { globalThis.__paymentRemittanceEmailTest.handler = handler } }',
  '@openbooks/jobs': 'export const EMAIL_QUEUE = "test"; export const getBlockingConnection = () => ({}); export const resolveEmailDeliveryKey = () => "delivery-key";',
  '../delivery/email-attachments.ts': 'export const loadEmailAttachments = async () => []; export const deleteStoredEmailAttachments = async () => {};',
  '@openbooks/emails': `
    export const deriveEmailDeliveryKey = () => 'delivery';
    export const reconcileDeliveryAttempts = () => ({ action: 'send' });
    export async function sendVia() {
      const state = globalThis.__paymentRemittanceEmailTest;
      state.sent++;
      if (state.sendError) throw state.sendError;
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
    export const markEmailFailed = async () => {};
    export const markEmailSent = async () => {};
    export const markEmailSuppressed = async () => {};
    export const markEmailUncertain = async () => {};
    export const markPaymentRemittanceAttempt = async (_org, id, attempt) => globalThis.__paymentRemittanceEmailTest.remittanceAttempts.push([id, attempt]);
    export const markPaymentRemittanceFailed = async (_org, id, error, attempt, terminal) => globalThis.__paymentRemittanceEmailTest.remittanceFailed.push([id, error, attempt, terminal]);
    export const markPaymentRemittanceSent = async (_org, id) => globalThis.__paymentRemittanceEmailTest.remittanceSent.push(id);
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

function job(attemptsMade = 0) {
  return {
    id: 'remittance-job',
    attemptsMade,
    opts: { attempts: 2 },
    data: {
      orgId: 'org',
      to: 'recipient@example.test',
      subject: 'test',
      html: '',
      text: '',
      meta: { paymentRemittanceId: 'rem-1' },
    },
  }
}

test('provider acceptance marks the payment remittance sent', async () => {
  assert.deepEqual(await state.handler(job()), { id: 'provider-1' })
  assert.equal(state.sent, 1)
  assert.deepEqual(state.remittanceAttempts, [['rem-1', 1]])
  assert.deepEqual(state.remittanceSent, ['rem-1'])
  assert.deepEqual(state.remittanceFailed, [])
})

test('a transport failure keeps the remittance pending for BullMQ retry', async () => {
  state.sendError = new Error('provider unavailable')
  await assert.rejects(state.handler(job()), /provider unavailable/)
  assert.deepEqual(state.remittanceAttempts.at(-1), ['rem-1', 1])
  assert.deepEqual(state.remittanceFailed.at(-1), ['rem-1', 'provider unavailable', 1, false])
  assert.deepEqual(state.remittanceSent, ['rem-1'])
})
