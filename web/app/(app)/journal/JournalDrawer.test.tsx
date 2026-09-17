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
test('a successful post re-pins the canonical revision so a later void cannot 409', () => {
  const postBlock = source.slice(source.indexOf('async function post()'), source.indexOf('async function remove()'))
  assert.ok(postBlock.includes('async function post()'), 'post() must exist')
  assert.match(
    postBlock,
    /refreshFromServer/,
    'post() must refresh the canonical snapshot after success: the post commits a new revision_seq and the drawer still holds the pre-post token',
  )
})
