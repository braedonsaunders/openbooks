import assert from 'node:assert/strict'
import test from 'node:test'
const {
  v1CreateAliasedRecord,
  v1DeleteAliasedRecord,
  v1GetAliasedRecord,
  v1ListAliasedRecords,
  v1UpdateAliasedRecord,
} = await import('./v1-records')

test('all pretty-path record handlers reject missing API keys without database access', async () => {
  const request = (method: string) => new Request('http://openbooks.test/api/v1/records', {method})
  const responses = await Promise.all([
    v1ListAliasedRecords(request('GET'), 'records'),
    v1CreateAliasedRecord(request('POST'), 'records'),
    v1GetAliasedRecord(request('GET'), 'records', 'record-1'),
    v1UpdateAliasedRecord(request('PATCH'), 'records', 'record-1'),
    v1DeleteAliasedRecord(request('DELETE'), 'records', 'record-1'),
  ])
  for (const response of responses) {
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), {error:'invalid or missing API key'})
  }
})
