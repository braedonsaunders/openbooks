import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./FileList.tsx', import.meta.url), 'utf8')

// react-hooks/refs: the row-menu builder runs during render, so the closures
// it creates must not reach a ref. The hidden file input is therefore clicked
// from an effect, never from the menu's onSelect path.
test('file replace opens the picker from an effect, not a render-created menu closure', () => {
  const startReplace = source.match(/function startReplace\([^)]*\) \{([\s\S]*?)\n  \}/)
  assert.ok(startReplace, 'startReplace must exist')
  assert.doesNotMatch(
    startReplace[1]!,
    /\.current/,
    'startReplace runs inside menu onSelect closures: touching a ref there remounts the refs violation (and risks a stale id)',
  )
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(replaceReq\) replaceInputRef\.current\?\.click\(\)\s*\}, \[replaceReq\]\)/,
    'the pending replace request must drive the hidden input click from an effect',
  )
})

// Cancelling the native picker fires no change event, so the request must be
// a fresh object per click — otherwise retrying replace on the same file
// would set identical state and the picker would never reopen.
test('each replace click mints a fresh request so picker-cancel retries work', () => {
  assert.match(
    source,
    /setReplaceReq\(\(prev\) => \(\{\s*id,\s*n: \(prev\?\.n \?\? 0\) \+ 1\s*\}\)\)/,
    'startReplace must bump a nonce so an identical retry still retriggers the effect',
  )
  assert.match(
    source,
    /if \(f && replaceReq\) void handleReplace\(replaceReq\.id, f\)/,
    'the picked file must upload against the requesting row id',
  )
  assert.doesNotMatch(
    source,
    /replaceTargetId/,
    'the target-id ref must stay retired: carrying the id in state is what keeps refs out of the menu builder',
  )
})
