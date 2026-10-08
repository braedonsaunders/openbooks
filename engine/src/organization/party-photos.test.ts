import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PARTY_PHOTO_BYTES, partyPhotoContentType } from './party-photos.ts'

test('party photos validate raster bytes instead of trusting a filename or declared type', () => {
  assert.equal(partyPhotoContentType(Buffer.from([137,80,78,71,13,10,26,10])), 'image/png')
  assert.equal(partyPhotoContentType(Buffer.from([255,216,255,224])), 'image/jpeg')
  assert.equal(partyPhotoContentType(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(partyPhotoContentType(Buffer.from('RIFFabcdWEBP')), 'image/webp')
  assert.throws(() => partyPhotoContentType(Buffer.from('<svg onload="alert(1)"></svg>')), /source bytes are not a supported photo/)
  assert.throws(() => partyPhotoContentType(Buffer.from('%PDF-1.7')), /source bytes are not a supported photo/)
  assert.throws(() => partyPhotoContentType(Buffer.alloc(0)), /empty/)
  assert.throws(() => partyPhotoContentType(Buffer.alloc(MAX_PARTY_PHOTO_BYTES + 1)), /5 MB/)
})
