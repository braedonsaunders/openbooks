import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { rendererArchive, verifyArchiveChecksum } from './install-pdf-browser.mjs'

test('native archives are distinct; unsupported architectures name the supported alternatives', () => {
  assert.notEqual(rendererArchive('amd64').url, rendererArchive('arm64').url)
  assert.throws(() => rendererArchive('riscv64'), /Unsupported.*riscv64.*Use amd64 or arm64/)
})
for (const [name, configuration] of [
  ['floating version', { version: 'stable', archives: { amd64: { platform: 'linux64', sha256: 'a'.repeat(64) } } }],
  ['wrong platform', { version: '154.0.8037.92', archives: { amd64: { platform: 'linux-arm64', sha256: 'a'.repeat(64) } } }],
  ['missing checksum', { version: '154.0.8037.92', archives: { amd64: { platform: 'linux64' } } }],
]) {
  test(`${name} refuses installation with a configuration remedy`, () => {
    assert.throws(() => rendererArchive('amd64', configuration), /Set its exact version, platform and SHA-256/)
  })
}
test('checksum verification accepts exact bytes and refuses altered bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openbooks-browser-checksum-'))
  try {
    const path = join(directory, 'archive')
    writeFileSync(path, 'abc')
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    await verifyArchiveChecksum(path, expected)
    writeFileSync(path, 'abd')
    await assert.rejects(verifyArchiveChecksum(path, expected), /checksum mismatch.*Refusing installation.*verify the pinned official archive/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
