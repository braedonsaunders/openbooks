import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const manifest = JSON.parse(readFileSync(new URL('./pdf-browser.json', import.meta.url), 'utf8'))

export function rendererArchive(architecture, configuration = manifest) {
  const expectedPlatform = new Map([['amd64', 'linux64'], ['arm64', 'linux-arm64']]).get(architecture)
  if (!expectedPlatform) throw new Error(`Unsupported PDF renderer architecture: ${architecture}. Use amd64 or arm64.`)
  const archive = configuration.archives?.[architecture]
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(configuration.version ?? '')
    || archive?.platform !== expectedPlatform || !/^[0-9a-f]{64}$/.test(archive?.sha256 ?? '')) {
    throw new Error(`Invalid pinned PDF renderer for ${architecture}. Set its exact version, platform and SHA-256.`)
  }
  return {
    version: configuration.version,
    directory: `chrome-${expectedPlatform}`,
    sha256: archive.sha256,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${configuration.version}/${expectedPlatform}/chrome-${expectedPlatform}.zip`,
  }
}

export async function verifyArchiveChecksum(path, expected) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== expected) {
    throw new Error('PDF renderer archive checksum mismatch. Refusing installation; verify the pinned official archive.')
  }
}

async function install(architecture, destination) {
  const archive = rendererArchive(architecture)
  if (!destination || existsSync(destination)) throw new Error('PDF renderer destination must name a new directory.')
  // Unpack beside the destination so the final rename stays on one filesystem.
  const temporary = mkdtempSync(join(dirname(resolve(destination)), '.openbooks-pdf-browser-'))
  try {
    const path = join(temporary, 'browser.zip')
    const response = await fetch(archive.url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok || !response.body) throw new Error(`Official PDF renderer download failed (${response.status}). Retry the pinned archive download.`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(path))
    await verifyArchiveChecksum(path, archive.sha256)
    execFileSync('unzip', ['-q', path, '-d', temporary], { timeout: 120_000 })
    const extracted = join(temporary, archive.directory)
    if (!existsSync(join(extracted, 'chrome'))) throw new Error('Verified PDF renderer archive has no executable. Refusing installation.')
    renameSync(extracted, destination)
    console.log(`Installed pinned PDF renderer ${archive.version} (${architecture}).`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await install(process.argv[2], process.argv[3])
}
