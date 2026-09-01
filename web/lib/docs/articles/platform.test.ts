import assert from 'node:assert/strict'
import test from 'node:test'
import { restApi } from './platform'

test('REST API documentation states the explicit-scope least-privilege contract', () => {
  const body = restApi.body

  assert.match(body, /at least one explicit \*\*scope\*\*/i)
  assert.match(body, /omitted or empty scope list is \*\*rejected\*\*/i)
  assert.match(body, /never inherits the\s+owner's full permissions from missing scopes/i)
  assert.doesNotMatch(body, /no scopes inherits the owner's full permissions/i)
})
