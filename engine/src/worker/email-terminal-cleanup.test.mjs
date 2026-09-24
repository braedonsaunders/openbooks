import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// E4: attachments on uncertain deliveries were retained forever. The
// reconciliation-suppress path threw without dropping staged blobs, and the
// uncertain path's throw landed in the already-recorded catch branch that
// skips the only terminal cleanup — so after retries exhausted and the
// failed job aged out of Redis, the S3 blobs sat unreferenced with no TTL.
// The fix keeps the no-resend gate but drops staged bytes once the delivery
// is terminal (retries exhausted, or suppress decided) with durable evidence
// on the email_log lineage.
globalThis.__emailTerminalCleanupTest = {
  attempts: [],
  sendMode: 'uncertain',
  sendViaCalls: 0,
  uncertainMarks: 0,
  deleted: [],
  transportResolution: { state: 'ready', transport: { provider: 'test' } },
}
const state = globalThis.__emailTerminalCleanupTest

const sources = {
  bullmq: 'export class Worker { constructor(_queue, handler) { globalThis.__emailTerminalCleanupTest.handler = handler } }',
  '@openbooks/jobs': 'export const EMAIL_QUEUE = "test"; export const getBlockingConnection = () => ({}); export const resolveEmailDeliveryKey = () => "delivery-key";',
  '../delivery/email-attachments.ts': `
    export const loadEmailAttachments = async () => [];
    export const deleteStoredEmailAttachments = async (attachments) => {
      globalThis.__emailTerminalCleanupTest.deleted.push(...(attachments ?? []));
    };
  `,
  '@openbooks/emails': `
    export async function sendVia() {
      const state = globalThis.__emailTerminalCleanupTest;
      state.sendViaCalls++;
      if (state.sendMode === 'uncertain') return { kind: 'uncertain', reason: 'acceptance state unresolved: provider timeout' };
      return { kind: 'sent', providerMessageId: 'provider-1' };
    }
    export function reconcileDeliveryAttempts(lineage) {
      if (lineage.some((r) => r.outcome === 'uncertain')) {
        return { action: 'suppress', reason: 'attempt 1 ended unresolved (prior timeout)' };
      }
      return { action: 'send' };
    }
  `,
  '../platform/db.ts': 'export const db = { execute: async () => ({ rows: [] }) }; export const withOrgContext = (_org, action) => action();',
  '../organization/sandbox-guard.ts': 'export const isSandboxOrg = async () => false;',
  '../delivery/email-config.ts': `
    export const resolveOrgEmailTransportDetailed = async () => globalThis.__emailTerminalCleanupTest.transportResolution;
    export const claimEmailDeliveryLog = async () => ({ id: 'log', attempts: globalThis.__emailTerminalCleanupTest.attempts });
    export const appendEmailAttemptEvent = async () => [];
    export const confirmEmailSentGuarded = async () => true;
    export const markEmailFailed = async () => {};
    export const markEmailSent = async () => {};
    export const markEmailSuppressed = async () => {};
    export const markEmailUncertain = async () => { globalThis.__emailTerminalCleanupTest.uncertainMarks++; };
    export const markPaymentRemittanceAttempt = async () => {};
    export const markPaymentRemittanceFailed = async () => {};
    export const markPaymentRemittanceSent = async () => {};
    export const markDunningClaimSent = async () => true;
    export const markDunningClaimFailed = async () => true;
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

const ATTACHMENTS = [{ filename: 'inv.pdf', contentType: 'application/pdf', storageKey: 'staged-1' }]

function job({ attemptsMade = 0, attempts = 5 } = {}) {
  return {
    id: 'email-job',
    attemptsMade,
    opts: { attempts },
    data: {
      orgId: 'org',
      to: 'billing@acme.test',
      subject: 'Invoice',
      html: '<p>Invoice</p>',
      text: 'Invoice',
      attachments: ATTACHMENTS,
      meta: {},
    },
  }
}

function reset() {
  state.attempts = []
  state.sendMode = 'uncertain'
  state.sendViaCalls = 0
  state.uncertainMarks = 0
  state.deleted = []
  state.transportResolution = { state: 'ready', transport: { provider: 'test' } }
}

test('uncertain on the final attempt deletes staged blobs, keeps evidence, never resends', async () => {
  reset()
  await assert.rejects(state.handler(job({ attemptsMade: 4, attempts: 5 })), /acceptance state unresolved/)
  assert.equal(state.uncertainMarks, 1, 'the uncertain verdict must stay on the email_log lineage')
  assert.deepEqual(state.deleted, ATTACHMENTS, 'exhausted retries must drop the staged blobs')
  assert.equal(state.sendViaCalls, 1, 'nothing may be re-sent')
})

test('reconciliation suppress deletes staged blobs without transmitting', async () => {
  reset()
  state.attempts = [{ attempt: 1, outcome: 'uncertain', detail: 'prior timeout' }]
  await assert.rejects(state.handler(job({ attemptsMade: 1, attempts: 5 })), /deferred by reconciliation/)
  assert.equal(state.sendViaCalls, 0, 'a suppressed delivery must never touch the wire')
  assert.deepEqual(state.deleted, ATTACHMENTS)
})

test('non-terminal uncertainty keeps staged blobs for the still-pending delivery', async () => {
  reset()
  await assert.rejects(state.handler(job({ attemptsMade: 0, attempts: 5 })), /acceptance state unresolved/)
  assert.equal(state.uncertainMarks, 1)
  assert.deepEqual(state.deleted, [], 'only a terminal delivery may drop staged bytes')
  assert.equal(state.sendViaCalls, 1)
})

test('configured but unusable transport fails with its remedy and does not ack or send', async () => {
  reset()
  state.transportResolution = {
    state: 'unusable',
    reason: 'credential could not be unsealed; re-enter it under Settings → Email',
  }
  await assert.rejects(
    state.handler(job({ attemptsMade: 0, attempts: 5 })),
    /configured but unusable: credential could not be unsealed.*re-enter it under Settings → Email/,
  )
  assert.equal(state.sendViaCalls, 0, 'a damaged credential must never reach the provider')
  assert.deepEqual(state.deleted, [], 'retries remain available until the transport is repaired')
})
