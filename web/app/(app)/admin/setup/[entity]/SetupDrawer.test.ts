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

test('blank keepDefault fields never block saving (F-t06-022)', () => {
  // keepDefault columns are NOT NULL WITH a DB default: the server omits
  // blanks and the default applies (coerce.ts). The drawer requiring them
  // made ownership creates (acquisitionRate, nciMeasurement, …) unsubmittable
  // with no user-discoverable workaround. Blank keepDefault must validate.
  const validateStart = source.indexOf('function validate()')
  const saveStart = source.indexOf('async function save()')
  assert.ok(validateStart >= 0 && saveStart > validateStart, 'validate() must exist')
  assert.match(
    source.slice(validateStart, saveStart),
    /keepDefault/,
    'validate() must honor keepDefault blanks as legal',
  )
})

test('typed server conflicts resolve through their code, never the raw message (F-t06-019)', () => {
  // Setup 409s carry {error: <human message>, code: 'duplicate'}: the drawer
  // must map through the code so a server-worded message still resolves to
  // the localized copy instead of echoing English into every locale.
  assert.match(
    source,
    /const code = record\?\.code/,
    'conflict mapping must read the typed code',
  )
})

test('typed validation failures render their message verbatim (F-t06-023)', () => {
  // Setup 400s carry {error: <user-language message>, code: 'invalid'}: the
  // drawer must render the message (naming the fix) rather than the code.
  assert.match(
    source,
    /const message = record\?\.error/,
    'validation mapping must read the server message',
  )
  assert.match(source, /errorMessage\(data\)/, 'call sites pass the whole body')
})

test('exclusion-conflict 409s resolve through the overlap code, never raw Postgres (F-t09-016)', () => {
  // The income-tax exclusion rejection arrived as a 400 echoing the raw
  // "conflicting key value violates exclusion constraint" string verbatim.
  // The server now answers 409 {code: 'overlap'} and the drawer must map
  // through the code to localized copy.
  assert.match(source, /code === 'overlap'/, 'the drawer must map the overlap code')
  assert.match(source, /t\('errors\.overlap'\)/, 'overlap must resolve to localized copy')
})

test('a hung or rejected save surfaces instead of wedging silently (F-t09-016)', () => {
  // A response that never arrives left the drawer open with no toast, a stale
  // table, and a stuck disabled button — every later click died silently.
  // save() must bound the request and name transport failures inline.
  assert.match(saveBlock(), /AbortController/, 'save() must bound the request')
  assert.match(saveBlock(), /catch/, 'save() must surface transport failures')
  assert.match(source, /saveTimedOut/, 'a timeout must name the maybe-saved state')
})

test('server required-field refusals render through the field label (F-t06-022 follow-up)', () => {
  // A server-side "X is required" still names the registry key: errorMessage
  // must map it through fields.* into validation.required — the same string
  // client-side validate() produces — instead of echoing camelCase.
  assert.match(
    source,
    /is required\$\//,
    'errorMessage must recognize the server required-field shape',
  )
  assert.match(
    source,
    /t\('validation\.required', \{ field: t\(`fields\./,
    'server required-field refusals must render through the field label',
  )
})

test('creates mint one idempotency key per mounted session and reuse it across retries', () => {
  // The drawer opens ?row=new with zero writes and POSTs once on Save: a
  // timeout or a second click retries the same payload, and without a stable
  // key the retry inserts a second row. The key must be assigned once per
  // mounted create session (never regenerated per attempt) so the retry
  // replays instead of duplicating.
  assert.match(
    source,
    /createRequestIdRef = useRef<string \| null>\(null\)/,
    'the drawer must hold one create-session key in a ref',
  )
  assert.match(
    source,
    /if \(creating && !createRequestIdRef\.current\) createRequestIdRef\.current = crypto\.randomUUID\(\)/,
    'the key must be assigned once and reused, never regenerated per save',
  )
})

test('the idempotency key travels only on create POSTs, never on PATCH', () => {
  // POST /api/admin/setup/[entity] requires the key; PATCH must not send
  // one, so an edit can never collide with (or replay as) a create.
  assert.match(
    source,
    /\.\.\.\(creating \? \{ 'Idempotency-Key': createRequestIdRef\.current! \} : \{\}\)/,
    'save() must send Idempotency-Key only when creating',
  )
  assert.ok(
    !/Idempotency-Key/.test(source.slice(source.indexOf('async function remove()'))),
    'delete must not send an idempotency key',
  )
})
