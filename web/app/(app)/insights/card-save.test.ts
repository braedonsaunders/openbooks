import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INITIAL_CARD_SAVE,
  cardSaveReducer,
  isCurrentSave,
  requestCardSave,
  shouldAdoptRevision,
  studioInstanceKey,
  type CardSaveDraft,
  type CardSaveMessages,
  type CardSaveOutcome,
} from './card-save'

// Unit suite for the Card Studio save plumbing (web/app/(app)/insights/…):
// the remount key, the save state machine, and the single-PATCH sender.
// fetch is the only seam (the network); validation, messages and the
// reducer run for real.

const MESSAGES: CardSaveMessages = {
  missingRevision: 'missing revision remedy',
  saveFailed: 'save failed fallback',
  unusableRevision: 'unusable revision remedy',
}

const DRAFT: CardSaveDraft = {
  name: 'Monthly spend',
  description: null,
  query: {
    source: 'ledger_lines',
    measures: [{ agg: 'sum', field: 'amount' }],
    dimensions: [{ field: 'posting_date', bin: 'month' }],
  },
  vizType: 'table',
  vizSettings: {},
}

const REVISION = '2026-08-24T12:00:00.300001Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('the studio remounts per card identity, including the unsaved blank', () => {
  assert.equal(studioInstanceKey('', true), 'card:new')
  assert.equal(studioInstanceKey('a-uuid', false), 'card:a-uuid')
  assert.notEqual(studioInstanceKey('', true), studioInstanceKey('a-uuid', false))
  assert.notEqual(studioInstanceKey('uuid-a', false), studioInstanceKey('uuid-b', false))
  assert.equal(studioInstanceKey('uuid-a', false), studioInstanceKey('uuid-a', false))
})

test('a refused save keeps the exact draft and pins the refusal', () => {
  const edited = cardSaveReducer(INITIAL_CARD_SAVE, { type: 'edit', draft: DRAFT })
  assert.equal(edited.status, 'dirty')
  assert.equal(edited.draft, DRAFT)

  const refused = cardSaveReducer(edited, {
    type: 'save-refused',
    // The realistic 409 text the card route answers with.
    message: 'this card changed after you opened it; reload and review the latest revision',
    conflict: true,
  })
  assert.equal(refused.status, 'error')
  assert.equal(refused.draft, DRAFT, 'the failed autosave must keep the unsaved edit, never revert it')
  assert.equal(refused.error, 'this card changed after you opened it; reload and review the latest revision')
  assert.equal(refused.conflict, true)

  // A further edit supersedes the draft but keeps the pinned message until
  // the next attempt resolves it.
  const nextDraft = { ...DRAFT, vizType: 'bar' as const }
  const reedited = cardSaveReducer(refused, { type: 'edit', draft: nextDraft })
  assert.equal(reedited.status, 'dirty')
  assert.equal(reedited.draft, nextDraft)
  assert.equal(reedited.error, refused.error)

  const saved = cardSaveReducer(reedited, { type: 'save-ok' })
  assert.equal(saved.status, 'saved')
  assert.equal(saved.error, null)
  assert.equal(saved.conflict, false)
  assert.equal(saved.draft, nextDraft)
})

test('a save with no revision token refuses locally and sends no request', async () => {
  let calls = 0
  const outcome = await requestCardSave({
    fetchFn: (async () => {
      calls += 1
      return jsonResponse(200, {})
    }) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: null,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'refused', message: 'missing revision remedy', conflict: false })
  assert.equal(calls, 0, 'a save that cannot carry a token must not reach the server')
})

test('a Bar-to-Table PATCH that the server accepts adopts the next revision', async () => {
  const sent: { url: string; body: Record<string, unknown> }[] = []
  const outcome = await requestCardSave({
    fetchFn: (async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String((init as { body: string }).body)) })
      return jsonResponse(200, { updated_at: '2026-08-24T12:00:00.300002Z' })
    }) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'saved', revision: '2026-08-24T12:00:00.300002Z' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.url, '/api/insights/cards/card-id')
  assert.equal(sent[0]?.body.vizType, 'table')
  assert.equal(sent[0]?.body.expectedUpdatedAt, REVISION)
})

test('a revision conflict surfaces the server refusal verbatim as a conflict', async () => {
  const outcome = await requestCardSave({
    fetchFn: (async () =>
      jsonResponse(409, { error: 'this card changed after you opened it; reload and review the latest revision' })) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, {
    kind: 'refused',
    message: 'this card changed after you opened it; reload and review the latest revision',
    conflict: true,
  })
})

test('a validation refusal surfaces the field-level server message without conflict', async () => {
  const outcome = await requestCardSave({
    fetchFn: (async () => jsonResponse(422, { error: 'Card name cannot be empty' })) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'refused', message: 'Card name cannot be empty', conflict: false })
})

test('a non-JSON refusal keeps the fallback with the status, never a parse error', async () => {
  const outcome = await requestCardSave({
    fetchFn: (async () => new Response('<html>proxy</html>', { status: 502 })) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'refused', message: 'save failed fallback (status 502)', conflict: false })
})

test('a 2xx without the next revision refuses with the named remedy', async () => {
  const outcome = await requestCardSave({
    fetchFn: (async () => jsonResponse(200, { ok: true })) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'refused', message: 'unusable revision remedy', conflict: false })
})

test('a 2xx that does not advance the carried revision is a refusal, never saved', async () => {
  const outcome = await requestCardSave({
    fetchFn: (async () => jsonResponse(200, { updated_at: REVISION })) as typeof fetch,
    cardId: 'card-id',
    draft: DRAFT,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'refused', message: 'unusable revision remedy', conflict: false })
})

test('overlapping saves resolving out of order accept only the newest', async () => {
  // Two debounced autosaves overlap: Bar (seq 1, superseded) and Table
  // (seq 2, current). Both carry the token the studio held when scheduled.
  const resolvers: Array<(response: Response) => void> = []
  const fetchFn = (() =>
    new Promise<Response>((resolve) => {
      resolvers.push(resolve)
    })) as typeof fetch
  const barDraft = { ...DRAFT, vizType: 'bar' as const }
  const tableDraft = { ...DRAFT, vizType: 'table' as const }
  const first = requestCardSave({ fetchFn, cardId: 'card-id', draft: barDraft, revision: REVISION, messages: MESSAGES })
  const second = requestCardSave({ fetchFn, cardId: 'card-id', draft: tableDraft, revision: REVISION, messages: MESSAGES })

  // The newest save's 200 lands first: the server holds Table at T2.
  resolvers[1]!(jsonResponse(200, { updated_at: '2026-08-24T12:00:00.300002Z' }))
  // The superseded Bar write lost the token race and 409s — landing last.
  resolvers[0]!(jsonResponse(409, { error: 'this card changed after you opened it; reload and review the latest revision' }))
  const [firstOutcome, secondOutcome] = await Promise.all([first, second])

  // The studio mirrors runSave: adopt forward, then gate on the sequence.
  let token: string | null = REVISION
  let machine = cardSaveReducer(cardSaveReducer(INITIAL_CARD_SAVE, { type: 'edit', draft: barDraft }), {
    type: 'edit',
    draft: tableDraft,
  })
  assert.equal(secondOutcome.kind, 'saved')
  if (secondOutcome.kind === 'saved') {
    if (shouldAdoptRevision(secondOutcome.revision, token)) token = secondOutcome.revision
    if (isCurrentSave(2, 2)) machine = cardSaveReducer(machine, { type: 'save-ok' })
  }
  assert.equal(token, '2026-08-24T12:00:00.300002Z')
  assert.equal(machine.status, 'saved', 'the newest save reports saved once the server confirms it')
  assert.equal(machine.draft, tableDraft, 'the displayed chart type is the newest edit')

  // The late loser changes nothing: not saved, no revert, no error flip.
  // (The cast keeps the gate exercisable: the mock always refuses here, so
  // without it the branch below is provably dead and tsc rejects it.)
  assert.equal(firstOutcome.kind, 'refused')
  const lateLoser = firstOutcome as CardSaveOutcome
  if (lateLoser.kind === 'saved') {
    if (shouldAdoptRevision(lateLoser.revision, token)) token = lateLoser.revision
    if (isCurrentSave(1, 2)) machine = cardSaveReducer(machine, { type: 'save-ok' })
  }
  assert.equal(machine.status, 'saved', 'a superseded response never sets or clears the outcome')
  assert.equal(machine.draft, tableDraft)
  assert.equal(token, '2026-08-24T12:00:00.300002Z')
})

test('a late 200 for a superseded draft adopts its token but never reports saved', async () => {
  // Save 1 (Bar, base T0) commits slowly; save 2 (Table, base T0) was
  // already scheduled when save 1's 200 lands last. The server holds Bar —
  // older than the studio — so saved must not show; but the T1 token is
  // newer than anything held, so the follow-up retry must carry it.
  let token: string | null = '2026-08-24T12:00:00.300000Z'
  let machine = cardSaveReducer(cardSaveReducer(INITIAL_CARD_SAVE, {
    type: 'edit',
    draft: { ...DRAFT, vizType: 'bar' as const },
  }), { type: 'edit', draft: DRAFT })
  const late: { kind: 'saved'; revision: string } = { kind: 'saved', revision: '2026-08-24T12:00:00.300001Z' }
  if (shouldAdoptRevision(late.revision, token)) token = late.revision
  if (isCurrentSave(1, 2)) machine = cardSaveReducer(machine, { type: 'save-ok' })
  assert.equal(token, '2026-08-24T12:00:00.300001Z', 'forward adoption keeps the retry token current')
  assert.notEqual(machine.status, 'saved', 'a superseded acceptance never reports saved')
  assert.equal(machine.draft, DRAFT, 'newer local state is never reverted')
})

test('revision adoption never moves the token backwards', () => {
  assert.equal(shouldAdoptRevision('2026-08-24T12:00:00.300002Z', '2026-08-24T12:00:00.300001Z'), true)
  assert.equal(shouldAdoptRevision('2026-08-24T12:00:00.300001Z', '2026-08-24T12:00:00.300002Z'), false)
  assert.equal(shouldAdoptRevision('2026-08-24T12:00:00.300001Z', null), true)
})

test('a dropped request refuses with the fallback and the draft is untouched', async () => {
  const frozen = structuredClone(DRAFT)
  Object.freeze(frozen)
  const outcome = await requestCardSave({
    fetchFn: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
    cardId: 'card-id',
    draft: frozen,
    revision: REVISION,
    messages: MESSAGES,
  })
  assert.deepEqual(outcome, { kind: 'refused', message: 'save failed fallback', conflict: false })
})
