import assert from 'node:assert/strict'
import test from 'node:test'
import { SETUP_ENTITIES } from './registry.ts'

// F4T-18: the /admin/setup/<key> redirect for a rehomed entity is derived
// from the registry, so every rehomed entry must record its home. A
// rehomed entity without rehomedTo is a bookmarked 404 with no way back.
test('every rehomed setup entity records its redirect home', () => {
  const rehomed = SETUP_ENTITIES.filter((entity) => entity.rehomed)
  assert.ok(rehomed.length > 0, 'the registry lists no rehomed entities')
  for (const entity of rehomed) {
    assert.ok(
      entity.rehomedTo && entity.rehomedTo.startsWith('/'),
      `${entity.key} is rehomed but records no redirect home`,
    )
    assert.ok(
      !/\s/.test(entity.rehomedTo),
      `${entity.key} records an unparseable redirect home`,
    )
  }
})

test('rehomed homes stay inside the app', () => {
  for (const entity of SETUP_ENTITIES.filter((entry) => entry.rehomedTo)) {
    assert.ok(
      entity.rehomedTo!.startsWith('/'),
      `${entity.key} redirects outside the app: ${entity.rehomedTo}`,
    )
  }
})
