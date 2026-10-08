import assert from 'node:assert/strict'
import test from 'node:test'
import { partyPhotoResponse } from './party-photo-response.ts'

const url = 'https://example.test/api/parties/employee/photo?v=file-1'
const photo = { name: 'employee.png',content_type: 'image/png',bytes: Buffer.from('original image'),version_id: 'version-1' }

test('a current photo URL revalidates and serves a replaced cabinet version without a new file ID', async () => {
  const first = partyPhotoResponse(new Request(url),photo)
  assert.equal(first.headers.get('cache-control'),'private, no-cache')
  const changed = partyPhotoResponse(new Request(url,{ headers: { 'if-none-match': first.headers.get('etag')! } }),
    { ...photo,bytes: Buffer.from('replacement image'),version_id: 'version-2' })
  assert.equal(changed.status,200)
  assert.equal(changed.headers.get('etag'),'"version-2"')
  assert.equal(changed.headers.get('cache-control'),'private, no-cache')
  assert.equal(await changed.text(),'replacement image')
  assert.equal(changed.headers.get('x-content-type-options'),'nosniff')
})

test('unchanged photo readback uses its version ETag for a private conditional response', async () => {
  const response = partyPhotoResponse(new Request(url,{ headers: { 'if-none-match': '"version-1"' } }),photo)
  assert.equal(response.status,304)
  assert.equal(response.headers.get('etag'),'"version-1"')
  assert.equal(response.headers.get('cache-control'),'private, no-cache')
  assert.equal(await response.text(),'')
})
