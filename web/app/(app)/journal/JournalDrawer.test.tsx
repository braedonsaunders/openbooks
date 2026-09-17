import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./JournalDrawer.tsx', import.meta.url), 'utf8')

test('journal voids carry the revision token required by the void API', () => {
  assert.match(
    source,
    /\/void`,\s*\{[\s\S]*?JSON\.stringify\(\{\s*reason,\s*expectedUpdatedAt/,
    'the void action must echo the canonical revision: /api/documents/[id]/void answers 409 without it, so a token-less void can never succeed',
  )
})

// F-t06-008: posting bumps documents.revision_seq on EVERY update (migration
// 0167 trigger), but post() kept the pre-post token — the next void in the
// same drawer session always 409s ("changed after you opened it"), and the
// keyless widget never refires its mount read, so close/reopen cannot heal it
// either. A successful post must re-pin the canonical revision.
// F-t06-006/F-t06-011: posting outside any period (or into a locked one)
// 422s, but the drawer showed nothing durable — a transient toast at best.
// A refused post pins a persistent in-drawer alert with the server reason.
test('a refused post pins a persistent alert with the server reason', () => {
  assert.match(
    source,
    /setPostError/,
    'post() must pin the refusal into drawer state: toasts alone expire and the findings show the failure reads as silent',
  )
  assert.match(
    source,
    /role="alert"/,
    'the pinned refusal must render as an alert the tester can still read after the toast expires',
  )
})

// F-t06-010: detaching from a posted record always 409s (evidence is
// retained), so posted journals must not offer Remove — uploading stays on.
test('posted journals lock attachment removal while keeping uploads', () => {
  assert.match(
    source,
    /canRemoveAttachments=\{doc\.status !== 'posted'\}/,
    'detach is impossible on posted records (409 retained): the journal must gate Remove on status, not offer it silently',
  )
})

test('a stale-revision void reloads and says so instead of toasting kernel text', () => {
  assert.match(
    source,
    /data\.code === 'stale-revision'/,
    'the void failure path must branch on the typed refusal code (F-t06-021): a stale token reloads the canonical revision with a localized message',
  )
  assert.match(
    source,
    /voidStaleRevision/,
    'the stale-revision branch must render localized copy, not the raw kernel refusal',
  )
})

test('a successful post re-pins the canonical revision so a later void cannot 409', () => {
  const postBlock = source.slice(source.indexOf('async function post()'), source.indexOf('async function remove()'))
  assert.ok(postBlock.includes('async function post()'), 'post() must exist')
  assert.match(
    postBlock,
    /refreshFromServer/,
    'post() must refresh the canonical snapshot after success: the post commits a new revision_seq and the drawer still holds the pre-post token',
  )
})

// F-t08-007: a journal that posts control legs with no party (JE-00005) went
// through with no warning at all. The post response carries the warning and
// the drawer pins it as a persistent alert until the next action — the same
// rule as post refusals (F-t06-006): toasts expire, the record must not.
test('a post with partyless control legs pins a persistent warning alert', () => {
  const postBlock = source.slice(source.indexOf('async function post()'), source.indexOf('async function remove()'))
  assert.ok(postBlock.includes('async function post()'), 'post() must exist')
  assert.match(
    postBlock,
    /partyless_control_lines/,
    'post() must branch on the typed warning code: only control legs with no party warn, never every post',
  )
  assert.match(
    postBlock,
    /setPostWarning/,
    'post() must pin the warning into drawer state: a toast alone expires and the finding shows the acceptance reads as silent',
  )
  assert.match(
    postBlock,
    /partylessControlWarning/,
    'the pinned warning must render localized copy through the drawer catalog, not raw server text',
  )
  assert.match(
    source,
    /\{postWarning \? \(\s*<p role="alert"/,
    'the pinned warning must render as an alert the reader still sees after the posted toast expires',
  )
})
