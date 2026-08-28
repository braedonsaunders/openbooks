import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

test('replacement delegates audit ownership to the transactional cabinet primitive', () => {
  assert.match(source, /replaceFile\([\s\S]*?audit: \{ actorId: gate\.user\.id \}/)
  assert.doesNotMatch(source, /recordFileEvent/)
})
