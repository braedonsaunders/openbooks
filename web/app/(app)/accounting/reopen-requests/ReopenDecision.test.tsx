import assert from 'node:assert/strict'
import test from 'node:test'

declare global {
  var __reopenTestRouter: { push(url: string): void; refresh(): void; replace(url: string): void } | undefined
  var __reopenTestToasts: { kind: string; message: string }[] | undefined
  /** Reason the prompt answers with; null models a cancelled prompt. */
  var __reopenTestPrompt: string | null | undefined
  var __reopenTestPromptCalls: { title: string; multiline?: boolean }[] | undefined
}

// jsdom first: the decision control reads browser globals at render.
const { bootJsdomEnvironment } = await import('../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/accounting/reopen-requests', matchMediaMatches: false, scrollIntoView: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return globalThis.__reopenTestRouter}export function usePathname(){return \'/accounting/reopen-requests\'}export function useSearchParams(){return new URLSearchParams()}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export const toast={success(m){(globalThis.__reopenTestToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__reopenTestToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}`,
      }
    }
    // Shared components import the prompt through "@/lib/prompt"; the suffix match covers that spelling.
    if (specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function promptDialog(options){(globalThis.__reopenTestPromptCalls??=[]).push({title:options.title,multiline:options.multiline});return globalThis.__reopenTestPrompt??null}`,
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { ReopenDecision } = await import('./ReopenDecision')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(element, value)
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}

async function mountDecision(requestId: string, ownRequest: boolean) {
  globalThis.__reopenTestRouter = { push() {}, refresh() {}, replace() {} }
  globalThis.__reopenTestToasts = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ReopenDecision requestId={requestId} ownRequest={ownRequest} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  await tick()
  return {
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function stubPreview(response: unknown, bodies: unknown[]) {
  const prior = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string }
    if (body.action === 'reopen-conflicts') return Response.json({
      eligibleApprovers: [], unconflictedApprovers: [], conflictAcknowledgementAllowed: false,
      ...(response && typeof response === 'object' ? response : {}),
    })
    bodies.push(body)
    return Response.json({ ok: true })
  }) as typeof fetch
  return prior
}

function approveButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Approve',
  ) as HTMLButtonElement | undefined
}

/** A conflict the engine will refuse disables Approve with the reason:
 * the control must mirror the decision instead of refusing on click. */
test('a conflicted reopen disables approve with the conflict reason', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [{ kind: 'authored_documents', count: 56, examples: ['INV-1', 'INV-2'] }],
    ownRequest: false,
    independenceRequired: true,
    selfApprovalAllowed: false,
  }, bodies)
  const { unmount } = await mountDecision('req-1', false)
  try {
    const approve = approveButton()
    assert.ok(approve, 'approve renders')
    assert.equal(approve.disabled, true, 'approve stays disabled while the engine would refuse it')
    assert.ok(
      (document.body.textContent ?? '').includes('56 record(s)'),
      'the control names the conflict with the reason',
    )
    await act(async () => {
      approve.click()
      await tick()
    })
    assert.deepEqual(bodies, [], 'a disabled approve posts nothing')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

/** A sole eligible approver deciding their own request attests: approve
 * waits for the reason and the checkbox, then posts the attestation. */
test('a sole approver self-approves with an attestation', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: true,
    independenceRequired: false,
    selfApprovalAllowed: true,
  }, bodies)
  const { unmount } = await mountDecision('req-2', true)
  try {
    const box = document.querySelector('textarea')
    assert.ok(box, 'the sole approver gets the attestation form')
    const approve = approveButton()
    assert.ok(approve, 'approve renders')
    assert.equal(approve.disabled, true, 'approve waits for the attestation and checkbox')
    assert.ok(approve.title, 'the disabled approve names what it waits for')
    const waiting = approve.title
    assert.ok(document.body.textContent?.includes(waiting), 'the requirement is stated beside the form, not only on hover')
    await act(async () => {
      setNativeValue(box as HTMLTextAreaElement, 'Only administrator available; this correction is necessary')
      await tick()
    })
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    assert.ok(checkbox, 'the attestation checkbox renders')
    await act(async () => {
      checkbox.click()
      await tick()
    })
    assert.equal(approveButton()!.disabled, false, 'reason and checkbox together enable approve')
    assert.ok(!document.body.textContent?.includes(waiting), 'the requirement note clears once satisfied')
    await act(async () => {
      approveButton()!.click()
      await tick()
      await tick()
    })
    assert.deepEqual(bodies, [{
      action: 'decide-reopen',
      requestId: 'req-2',
      approve: true,
      attestation: 'Only administrator available; this correction is necessary',
    }])
    assert.ok(
      (globalThis.__reopenTestToasts ?? []).some((toast) => toast.kind === 'success'),
      'the approval toasts success',
    )
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

/** An own request with another eligible approver offers no approve or
 * reject: the requester cannot decide it and may only withdraw it. */
test('an own request with an available approver offers no approve or reject controls', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: true,
    independenceRequired: true,
    selfApprovalAllowed: false,
  }, bodies)
  const { unmount } = await mountDecision('req-3', true)
  try {
    assert.equal(approveButton(), undefined, 'no approve control for an undecidable own request')
    assert.ok(
      (document.body.textContent ?? '').includes('another approver must decide'),
      'the requester is told to route it elsewhere',
    )
    assert.deepEqual(bodies, [], 'nothing posts')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

/** The requester learns whom to ask: the eligible approvers are named. */
test('an own request names the approvers who can decide it', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: true,
    independenceRequired: true,
    selfApprovalAllowed: false,
    eligibleApprovers: ['Erik Halvorsen', 'Mira Chen'],
  }, bodies)
  const { unmount } = await mountDecision('req-4', true)
  try {
    assert.equal(approveButton(), undefined, 'no approve control for an undecidable own request')
    assert.ok(
      (document.body.textContent ?? '').includes('Erik Halvorsen, Mira Chen can decide it from My approvals'),
      'the eligible approvers are named',
    )
    assert.deepEqual(bodies, [], 'nothing posts')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

/** With no unconflicted approver, the conflicted approver records an
 * acknowledgement instead of facing a disabled Approve forever. */
test('a conflicted approver with no unconflicted alternative approves with an acknowledgement', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [{ kind: 'party_records', count: 4, examples: ['PAY-00002', 'PAY-00003', 'PAYD-1'] }],
    ownRequest: false,
    independenceRequired: true,
    selfApprovalAllowed: false,
    eligibleApprovers: ['Erik Halvorsen'],
    unconflictedApprovers: [],
    conflictAcknowledgementAllowed: true,
  }, bodies)
  const { unmount } = await mountDecision('req-5', false)
  try {
    const text = document.body.textContent ?? ''
    assert.ok(text.includes('no other eligible approver is free of conflicts'), 'the acknowledgement path is explained')
    assert.ok(text.includes('PAY-00002, PAY-00003, PAYD-1, …'), 'a truncated example list says so')
    const approve = approveButton()
    assert.ok(approve?.disabled, 'approve waits for the acknowledgement')
  } finally {
    await unmount()
    globalThis.fetch = prior
  }
})

function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
}

function answerPrompt(reason: string | null | undefined) {
  globalThis.__reopenTestPrompt = reason
  globalThis.__reopenTestPromptCalls = []
}

/** A requester withdraws their own pending request with a reason. The
 * request is recorded as withdrawn, so the requester has no reject control. */
test('the requester withdraws an own pending request with a reason and has no reject control', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: true,
    independenceRequired: true,
    selfApprovalAllowed: false,
    eligibleApprovers: ['Erik Halvorsen'],
  }, bodies)
  answerPrompt('Changed my mind; the correction is no longer needed')
  const { unmount } = await mountDecision('req-6', true)
  try {
    assert.equal(buttonNamed('Reject'), undefined, 'the requester cannot reject their own request')
    const withdraw = buttonNamed('Withdraw request')
    assert.ok(withdraw, 'the requester sees Withdraw request')
    await act(async () => {
      withdraw.click()
      await tick()
      await tick()
    })
    assert.equal(globalThis.__reopenTestPromptCalls?.[0]?.title, 'Withdraw reopen request', 'withdrawal asks for a reason first')
    assert.equal(globalThis.__reopenTestPromptCalls?.[0]?.multiline, true)
    assert.deepEqual(bodies, [{
      action: 'withdraw-reopen',
      requestId: 'req-6',
      reason: 'Changed my mind; the correction is no longer needed',
    }])
    assert.ok(
      (globalThis.__reopenTestToasts ?? []).some((toast) => toast.kind === 'success' && toast.message === 'Reopen request withdrawn.'),
      'the withdrawal toasts success',
    )
  } finally {
    await unmount()
    globalThis.fetch = prior
    answerPrompt(undefined)
  }
})

/** Cancelling the withdrawal prompt posts nothing. */
test('a cancelled withdrawal prompt posts nothing', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: true,
    independenceRequired: true,
    selfApprovalAllowed: false,
  }, bodies)
  answerPrompt(null)
  const { unmount } = await mountDecision('req-7', true)
  try {
    await act(async () => {
      buttonNamed('Withdraw request')!.click()
      await tick()
      await tick()
    })
    assert.equal(globalThis.__reopenTestPromptCalls?.length, 1, 'the prompt opened')
    assert.deepEqual(bodies, [], 'a cancelled withdrawal posts nothing')
  } finally {
    await unmount()
    globalThis.fetch = prior
    answerPrompt(undefined)
  }
})

/** An approver's rejection records a reason: the prompt gates the post,
 * and the reason travels as decisionReason. */
test('an approver rejects with a recorded reason, and a cancelled prompt posts nothing', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: false,
    independenceRequired: false,
    selfApprovalAllowed: false,
  }, bodies)
  answerPrompt(null)
  const { unmount } = await mountDecision('req-8', false)
  try {
    await act(async () => {
      buttonNamed('Reject')!.click()
      await tick()
      await tick()
    })
    assert.deepEqual(bodies, [], 'a cancelled rejection posts nothing')
    globalThis.__reopenTestPrompt = 'The window is broader than the correction needs'
    await act(async () => {
      buttonNamed('Reject')!.click()
      await tick()
      await tick()
    })
    assert.equal(globalThis.__reopenTestPromptCalls?.[1]?.title, 'Reject reopen request', 'rejection asks for a reason')
    assert.deepEqual(bodies, [{
      action: 'decide-reopen',
      requestId: 'req-8',
      approve: false,
      decisionReason: 'The window is broader than the correction needs',
    }])
  } finally {
    await unmount()
    globalThis.fetch = prior
    answerPrompt(undefined)
  }
})

/** A sole approver deciding their own request withdraws it instead of
 * rejecting: the attestation form stays for approval only. */
test('a sole approver with an own request withdraws rather than rejects', async () => {
  const bodies: unknown[] = []
  const prior = stubPreview({
    ok: true,
    conflicts: [],
    ownRequest: true,
    independenceRequired: false,
    selfApprovalAllowed: true,
  }, bodies)
  answerPrompt('Withdrawing: a different correction will be requested')
  const { unmount } = await mountDecision('req-9', true)
  try {
    assert.equal(buttonNamed('Reject'), undefined, 'no reject control for the requester')
    assert.ok(buttonNamed('Withdraw request'), 'the withdraw control is offered beside approve')
    assert.ok(document.querySelector('textarea'), 'the sole approver still gets the attestation form for approval')
    await act(async () => {
      buttonNamed('Withdraw request')!.click()
      await tick()
      await tick()
    })
    assert.deepEqual(bodies, [{
      action: 'withdraw-reopen',
      requestId: 'req-9',
      reason: 'Withdrawing: a different correction will be requested',
    }])
  } finally {
    await unmount()
    globalThis.fetch = prior
    answerPrompt(undefined)
  }
})
