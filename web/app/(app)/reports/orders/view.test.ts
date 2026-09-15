import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('orders report aggregates exact open values without Number coercion', () => {
  assert.match(source, /import \{ decimalSum \} from ['"]\.\.\/\.\.\/\.\.\/\.\.\/lib\/statement-format['"]/)
  assert.match(source, /const openValue = decimalSum\(forKind\.map\(\(r\) => String\(r\.open_value \?\? '0'\)\)\)/)
  assert.doesNotMatch(source, /Number\(r\.open_value/)
})
