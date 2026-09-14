import assert from 'node:assert/strict'
import test from 'node:test'
import { scannedImages, verifyManifest, manifestDigest } from './scanned-image-manifest.mjs'

const expected = { source: 'a'.repeat(40), runId: '123', image: 'ghcr.io/example/openbooks' }
const receipts = ['amd64', 'arm64'].map((arch, i) => ({ arch, platform: `linux/${arch}`, source: expected.source, runId: expected.runId, digest: `sha256:${String(i + 1).repeat(64)}` }))
const manifest = { schemaVersion: 2, manifests: receipts.map(receipt => ({ platform: { os: 'linux', architecture: receipt.arch }, digest: receipt.digest })) }

test('release index contains both exact scanned native images', () => {
  const images = scannedImages(receipts, expected)
  verifyManifest(manifest, images)
  assert.equal(images[0].reference, `${expected.image}@${receipts[0].digest}`)
})

test('missing, duplicate, foreign-run, and foreign-source scan receipts refuse publication', () => {
  for (const values of [receipts.slice(0, 1), [receipts[0], receipts[0]],
    [receipts[0], { ...receipts[1], source: 'b'.repeat(40) }],
    [receipts[0], { ...receipts[1], runId: '124' }]]) {
    assert.throws(() => scannedImages(values, expected))
  }
})

test('manifest substitutions and extra platforms refuse publication', () => {
  const images = scannedImages(receipts, expected)
  assert.throws(() => verifyManifest({ ...manifest, manifests: [manifest.manifests[0], { ...manifest.manifests[1], digest: `sha256:${'f'.repeat(64)}` }] }, images))
  assert.throws(() => verifyManifest({ ...manifest, manifests: [...manifest.manifests, manifest.manifests[0]] }, images))
})

test('buildx metadata must identify an immutable OCI index', () => {
  const descriptor = { mediaType: 'application/vnd.oci.image.index.v1+json', digest: `sha256:${'f'.repeat(64)}` }
  assert.equal(manifestDigest({ 'containerimage.descriptor': descriptor }), descriptor.digest)
  assert.throws(() => manifestDigest({ 'containerimage.descriptor': { ...descriptor, digest: 'latest' } }))
})
