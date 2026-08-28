import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')

test('bulk mutations share one transaction and pass its executor to every verb', () => {
  assert.match(source, /inDbTransaction\(async \(tx\)/)
  assert.match(source, /const audit = \{ actorId: gate\.user\.id, executor: tx \}/)
  assert.match(source, /moveFile\([\s\S]*?audit\)/)
  assert.match(source, /moveFolder\([\s\S]*?audit\)/)
  assert.match(source, /deleteFile\([\s\S]*?audit\)/)
  assert.match(source, /deleteFolder\([\s\S]*?audit\)/)
  assert.doesNotMatch(source, /recordFileEvent/)
})
