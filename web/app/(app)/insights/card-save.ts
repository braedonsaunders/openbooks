import type { InsightQuery, VizSettings, VizType } from '@openbooks/analytics'
import { readApiErrorMessage } from '../../../lib/api-error'

/**
 * Card Studio save plumbing, extracted from CardStudio.tsx so the contract
 * is unit-testable without a DOM renderer:
 *
 * - `studioInstanceKey` remounts the studio per card identity, so a client
 *   navigation from `?card=new` to `?card=<uuid>` (or card A to card B)
 *   cannot keep editing with the previous card's revision token — or the
 *   previous card's fields.
 * - `cardSaveReducer` is the whole save state machine. A refused save only
 *   ever sets the error/conflict flags: the draft is kept by reference, so a
 *   failed autosave can never revert or drop the operator's edit.
 * - `requestCardSave` sends one autosave PATCH. The revision token is
 *   checked BEFORE any fetch (a missing token refuses locally with a named
 *   remedy instead of sending a save that cannot succeed), and the response
 *   status is branched BEFORE the body is read — a refusal's `{ error }`
 *   reaches the footer verbatim, never a parse error.
 */

/** The draft an autosave PATCH carries — exactly CardStudio's savePayload. */
export interface CardSaveDraft {
  name: string
  description: string | null
  query: InsightQuery
  vizType: VizType
  vizSettings: VizSettings
}

export type CardSaveStatus = 'saved' | 'saving' | 'dirty' | 'error'

export interface CardSaveMachine {
  status: CardSaveStatus
  /** The latest local edit. Kept by reference through every refusal. */
  draft: CardSaveDraft | null
  /** The server's refusal (or the local no-revision refusal), pinned for the footer. */
  error: string | null
  /** True when the refusal was a 409 revision conflict (reload/overwrite apply). */
  conflict: boolean
}

export type CardSaveEvent =
  | { type: 'edit'; draft: CardSaveDraft }
  | { type: 'save-start' }
  | { type: 'save-ok' }
  | { type: 'save-refused'; message: string; conflict: boolean }

export const INITIAL_CARD_SAVE: CardSaveMachine = {
  status: 'saved',
  draft: null,
  error: null,
  conflict: false,
}

export function cardSaveReducer(state: CardSaveMachine, event: CardSaveEvent): CardSaveMachine {
  switch (event.type) {
    case 'edit':
      // A new edit supersedes the pending draft but never clears a pinned
      // refusal: the message stays until the next save attempt resolves it.
      return { ...state, status: 'dirty', draft: event.draft }
    case 'save-start':
      return { ...state, status: 'saving' }
    case 'save-ok':
      return { ...state, status: 'saved', error: null, conflict: false }
    case 'save-refused':
      // The draft is deliberately untouched: the operator's edit stays in
      // the studio exactly as typed, alongside the reason it did not save.
      return { ...state, status: 'error', error: event.message, conflict: event.conflict }
  }
}

/**
 * One studio instance per card identity. The `card-studio` widget uses this
 * as the element key so each card (and the unsaved `new` blank) mounts a
 * fresh studio seeded with the server-loaded revision — a reused instance
 * would autosave with a token that belongs to another card, or to no row.
 */
export function studioInstanceKey(cardId: string, createMode: boolean): string {
  return createMode ? 'card:new' : `card:${cardId}`
}

export type CardSaveOutcome =
  | { kind: 'saved'; revision: string }
  | { kind: 'refused'; message: string; conflict: boolean }

/**
 * Fencing for overlapping saves: only the newest scheduled save may set the
 * studio to saved. A response for any older sequence is discarded — it must
 * neither set saved nor revert newer local state, even when the server
 * accepted that older write (the server then holds older content than the
 * studio shows, and the newer save's own outcome reports it).
 */
export function isCurrentSave(seq: number, currentSeq: number): boolean {
  return seq === currentSeq
}

/**
 * Adopt only forward. A late response for an older write must never move the
 * token backwards — the next save would 409 against a revision the server
 * has already superseded. String order is chronological order here: both
 * tokens come from the card routes' fixed-width microsecond format
 * (`YYYY-MM-DDTHH24:MI:SS.USZ`, exactly six fractional digits).
 */
export function shouldAdoptRevision(candidate: string, current: string | null | undefined): boolean {
  return typeof current !== 'string' || candidate > current
}

export interface CardSaveMessages {
  /** Named remedy when no revision token exists yet (nothing was sent). */
  missingRevision: string
  /** Fallback when the server answered without a usable `{ error }`. */
  saveFailed: string
  /** The server answered 2xx but without the next revision token. */
  unusableRevision: string
}

/**
 * Send one autosave PATCH for `draft`, guarded by `revision`.
 * `fetchFn` is injected so tests can prove the no-token path sends nothing.
 */
export async function requestCardSave(args: {
  fetchFn: typeof fetch
  cardId: string
  draft: CardSaveDraft
  revision: string | null | undefined
  messages: CardSaveMessages
  signal?: AbortSignal
}): Promise<CardSaveOutcome> {
  const { fetchFn, cardId, draft, revision, messages, signal } = args
  if (!revision) {
    return { kind: 'refused', message: messages.missingRevision, conflict: false }
  }
  let res: Response
  try {
    res = await fetchFn(`/api/insights/cards/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...draft, expectedUpdatedAt: revision }),
      signal,
    })
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error
    return { kind: 'refused', message: messages.saveFailed, conflict: false }
  }
  // The status is branched first: a refusal body is read only to extract
  // the server's `{ error }`, and a non-JSON body keeps the fallback —
  // the operator always reads the refusal, never a parse error.
  if (!res.ok) {
    return {
      kind: 'refused',
      message: await readApiErrorMessage(res, messages.saveFailed),
      conflict: res.status === 409,
    }
  }
  const data = (await res.json().catch(() => null)) as { updated_at?: unknown } | null
  // A 2xx confirms OUR write only when the returned revision advances past
  // the token this request carried. The PATCH route advances updated_at on
  // every matched write and 409s when the token no longer matches, so an
  // equal or older revision means the server did not confirm this state —
  // reporting saved would be a false success that a reload then reverts.
  if (typeof data?.updated_at !== 'string' || data.updated_at <= revision) {
    return { kind: 'refused', message: messages.unusableRevision, conflict: false }
  }
  return { kind: 'saved', revision: data.updated_at }
}
