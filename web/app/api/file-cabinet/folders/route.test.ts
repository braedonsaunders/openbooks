import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

test('folder creation passes actor attribution into the transactional primitive', () => {
  assert.match(source, /createFolder\([\s\S]*?audit: \{ actorId: gate\.user\.id \}/)
  assert.doesNotMatch(source, /recordFileEvent/)
})
