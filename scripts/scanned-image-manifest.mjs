import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arches = ['amd64', 'arm64']
const digestPattern = /^sha256:[0-9a-f]{64}$/

export function scannedImages(receipts, { source, runId, image }) {
  assert.match(source, /^[0-9a-f]{40}$/)
  assert.match(String(runId), /^[1-9][0-9]*$/)
  assert.match(image, /^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/)
  assert.deepEqual(receipts.map(receipt => receipt.arch).sort(), arches)
  return arches.map(arch => {
    const receipt = receipts.find(value => value.arch === arch)
    assert.equal(receipt.source, source, 'scanned image source differs from release source')
    assert.equal(String(receipt.runId), String(runId), 'scanned image belongs to another run')
    assert.equal(receipt.platform, `linux/${arch}`)
    assert.match(receipt.digest, digestPattern)
    return { arch, digest: receipt.digest, reference: `${image}@${receipt.digest}` }
  })
}

export function verifyManifest(manifest, images) {
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.manifests.length, 2, 'release must contain exactly two scanned images')
  assert.deepEqual(manifest.manifests.map(value => value.platform.architecture).sort(), arches)
  for (const image of images) {
    const entry = manifest.manifests.find(value => value.platform.architecture === image.arch)
    assert.equal(entry.platform.os, 'linux')
    assert.equal(entry.digest, image.digest, 'release manifest contains an unscanned image')
  }
}

export function manifestDigest(metadata) {
  const descriptor = metadata['containerimage.descriptor']
  assert.ok(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(descriptor.mediaType))
  assert.match(descriptor.digest, digestPattern)
  return descriptor.digest
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [command, directory, manifestPath] = process.argv.slice(2)
  if (command === 'digest') {
    console.log(manifestDigest(JSON.parse(readFileSync(directory, 'utf8'))))
  } else {
    assert.deepEqual(readdirSync(directory).sort(), ['amd64.json', 'arm64.json'])
    const receipts = arches.map(arch => JSON.parse(readFileSync(resolve(directory, `${arch}.json`), 'utf8')))
    const images = scannedImages(receipts, { source: process.env.SOURCE_COMMIT, runId: process.env.GITHUB_RUN_ID, image: process.env.IMAGE_NAME })
    if (command === 'sources') console.log(images.map(image => image.reference).join('\n'))
    else if (command === 'verify') verifyManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), images)
    else throw new Error('Expected sources, digest, or verify')
  }
}
