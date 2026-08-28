import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../app/(app)/knowledge/views/ViewStudio.tsx', import.meta.url), 'utf8')
const autosave = source.slice(source.indexOf('// --- autosave (debounced PATCH) ---'), source.indexOf('const selectableColumns'))

test('view autosaves serialize PATCH requests and ignore superseded snapshots', () => {
  assert.match(autosave, /const saveChainRef = useRef\(Promise\.resolve\(\)\)/)
  assert.match(autosave, /const saveRevisionRef = useRef\(0\)/)
  assert.match(autosave, /const revision = \+\+saveRevisionRef\.current/)
  assert.match(autosave, /if \(revision !== saveRevisionRef\.current\) return/)

  const queue = autosave.indexOf('saveChainRef.current = saveChainRef.current.then(save, save)')
  const saveTask = autosave.indexOf('const save = async () =>')
  const request = autosave.indexOf('await fetch(`/api/views/${view.id}`')
  assert.ok(queue !== -1, 'each delayed save must join the shared promise chain')
  assert.ok(saveTask !== -1, 'each queued entry must have one save task')
  assert.ok(request !== -1, 'the autosave must still issue the view PATCH')
  assert.ok(request > saveTask && request < queue, 'the PATCH must be created inside the serialized save task')
  assert.match(autosave, /revision === saveRevisionRef\.current\) setSaveState\('saved'\)/)
})

test('view autosaves retain the complete definition payload', () => {
  assert.match(autosave, /body: JSON\.stringify\(\{ name, description, query, scope \}\)/)
})
