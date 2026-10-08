import assert from 'node:assert/strict'
import test from 'node:test'
import sharp from 'sharp'
import { prepareConnectorPhoto, MAX_SOURCE_PHOTO_BYTES } from './photo-preparation.ts'
import { MAX_PARTY_PHOTO_BYTES } from './party-photos.ts'

test('connector display preparation retains oversized source bytes and is deterministic', async () => {
  const rgb = Buffer.alloc(2000 * 1000 * 3)
  for (let i=0;i<rgb.length;i++) rgb[i]=(i*17+i%251)%256
  const original = await sharp(rgb,{ raw: { width: 2000,height: 1000,channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
  assert.ok(original.length > MAX_PARTY_PHOTO_BYTES)
  const file = { filename: 'source.png',bytes: original }
  const prepared = await prepareConnectorPhoto(file)
  assert.equal(prepared.contentType,'image/webp')
  assert.ok(prepared.bytes.length <= MAX_PARTY_PHOTO_BYTES)
  assert.ok(prepared.original?.bytes.equals(original))
  assert.ok((await prepareConnectorPhoto(file)).bytes.equals(prepared.bytes))
  const metadata = await sharp(prepared.bytes).metadata()
  assert.ok(metadata.width! <= 1600 && metadata.height! <= 1600)
  const replay = await prepareConnectorPhoto({ filename: prepared.filename,bytes: prepared.bytes })
  assert.ok(replay.bytes.equals(prepared.bytes))
  assert.equal(replay.original,undefined)
})

test('oversized and non-raster source files refuse instead of producing a placeholder', async () => {
  await assert.rejects(prepareConnectorPhoto({ filename: 'large.png',bytes: Buffer.alloc(MAX_SOURCE_PHOTO_BYTES+1) }),/25 MB/)
  await assert.rejects(prepareConnectorPhoto({ filename: 'photo.svg',bytes: Buffer.from('<svg/>') }),/supported photo/)
})
