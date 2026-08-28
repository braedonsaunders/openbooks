import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./RemittancesView.tsx', import.meta.url), 'utf8')

test('remittance bill payload follows edited dates while preserving unchanged range values', () => {
  assert.match(source, /const \[range, setRange\] = useState\(\{ from, to \}\)/)
  assert.match(source, /value=\{range\.from\}[\s\S]*?from: e\.target\.value/)
  assert.match(source, /value=\{range\.to\}[\s\S]*?to: e\.target\.value/)

  const payload = source.match(/body: JSON\.stringify\(\{([\s\S]*?)\n        \}\),/)?.[1]
  assert.ok(payload, 'create-bill must serialize a request payload')
  assert.match(payload, /from: range\.from/)
  assert.match(payload, /to: range\.to/)
  assert.doesNotMatch(payload, /^\s*from,\s*$/m)
  assert.doesNotMatch(payload, /^\s*to,\s*$/m)
})
