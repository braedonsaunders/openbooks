import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./SetupDrawer.tsx', import.meta.url)), 'utf8')

function saveBlock(): string {
  const start = source.indexOf('async function save()')
  const end = source.indexOf('async function remove()')
  assert.ok(start >= 0 && end > start, 'save() must exist')
  return source.slice(start, end)
}

test('required setup fields are visibly marked (F-t06-018)', () => {
  // The account-groups registry declares dimension required, but nothing in
  // the drawer showed it — the user could only discover the requirement by
  // guessing. Field labels must mark required fields.
  assert.match(
    source,
    /field\.required[\s\S]{0,300}requiredMark/,
    'field labels must render a required marker driven by field.required',
  )
  assert.match(source, /\{label\}\{requiredMark\}/, 'the marker rides the field label')
})

test('validation failures persist inline naming the field, not toast-only (F-t06-018)', () => {
  // A blocked save that only fires a transient toast reads as "nothing
  // happened" once it dismisses. The drawer must keep a persistent
  // form-level error naming the missing field.
  assert.match(source, /fieldError/, 'the drawer must track a persistent field error')
  assert.match(source, /role="alert"/, 'the persistent error must be an accessible alert')
})

test('a failed transport cannot wedge the save button on (F-t06-018)', () => {
  // save() set busy before fetch with no finally: a rejected fetch left the
  // Create/Save button permanently disabled with zero feedback on later
  // clicks. Busy must reset even when the transport throws.
  assert.match(saveBlock(), /finally/, 'save() must reset busy in a finally block')
})

test('typed server conflicts resolve through their code, never the raw message (F-t06-019)', () => {
  // Setup 409s carry {error: <human message>, code: 'duplicate'}: the drawer
  // must map through the code so a server-worded message still resolves to
  // the localized copy instead of echoing English into every locale.
  assert.match(
    source,
    /data\?\.code \?\? data\?\.error/,
    'conflict mapping must prefer the typed code over the message',
  )
})
