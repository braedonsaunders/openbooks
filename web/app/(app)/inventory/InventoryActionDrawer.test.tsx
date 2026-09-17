import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const drawerSource = readFileSync(join(webRoot, 'app/(app)/inventory/InventoryActionDrawer.tsx'), 'utf8')

// F-t07-001: movement Post failures (missing period, insufficient stock) were
// completely silent — no persistent message, typed values intact but no
// reason on the record. A refused Post must pin the server's reason as an
// alert until the next submit.
test('movement post refusals pin to the record until the next submit (F-t07-001)', () => {
  assert.match(drawerSource, /const \[postError, setPostError\] = useState<string \| null>\(null\)/)
  assert.match(drawerSource, /<p role="alert"[\s\S]*?\{postError/)
  assert.match(drawerSource, /setPostError\(null\)/)
  assert.match(drawerSource, /data\.error/)
  // A non-JSON refusal must not become an unhandled rejection with the
  // spinner stuck on: fall back to the generic failure copy.
  assert.match(drawerSource, /await res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/)
})
