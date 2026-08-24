import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * PDF encryption for the shared PDF layer.
 *
 * Any record PDF that carries confidential figures — pay stubs above all, but
 * equally a customer statement or a compensation letter — can be produced
 * password-protected by passing its bytes through here. Encryption is applied
 * as a POST-PROCESSING pass: neither of the two renderers in this package can
 * write an encrypted file (Chromium's print-to-PDF has no encryption option,
 * and pdfkit/pdf-lib only write unencrypted documents).
 *
 * The encryptor is qpdf, invoked as an external binary, for three reasons:
 * nothing in the dependency tree can write AES-encrypted PDFs; the JS options
 * are an unmaintained native addon or a fork of pdf-lib; and this package
 * already depends on an external binary for its main renderer (Chromium, via
 * puppeteer-core), so provisioning one more system package in the runtime
 * image is an established operational pattern rather than a new one.
 * AES-256 is used, which is the modern PDF 2.0 algorithm.
 *
 * SECURITY:
 * - The password NEVER appears in argv (it would be readable in the process
 *   table by any local user). qpdf's `@-` form reads the whole argument list
 *   from stdin, so the secret only ever crosses a private pipe.
 * - Plaintext and ciphertext live in a private temp directory that is removed
 *   in `finally`, on success and on failure alike.
 * - Nothing here logs the password, and errors never quote it.
 */

export class PdfEncryptionError extends Error {}

export interface PdfEncryptionOptions {
  /** Password required to OPEN the document. */
  userPassword: string
  /**
   * Password required to change permissions. Defaults to the user password,
   * which is what an employer distributing stubs wants: no second secret to
   * manage, and no owner-password bypass of the permissions below.
   */
  ownerPassword?: string
  /** Allow printing (default true — a stub is meant to be printable). */
  allowPrinting?: boolean
  /** Allow content extraction/copy (default false). */
  allowExtraction?: boolean
}

/** qpdf binary path: explicit override, else the one on PATH. */
function qpdfExecutable(): string {
  return process.env.OPENBOOKS_QPDF_PATH?.trim() || 'qpdf'
}

/**
 * Encrypt a PDF with AES-256. Throws PdfEncryptionError when the binary is
 * missing or qpdf refuses the file — callers handling confidential output must
 * FAIL rather than fall back to sending the document in the clear.
 */
export async function encryptPdf(
  pdf: Buffer | Uint8Array,
  options: PdfEncryptionOptions,
): Promise<Buffer> {
  const userPassword = options.userPassword
  if (!userPassword) throw new PdfEncryptionError('an empty password would not protect the document')
  const ownerPassword = options.ownerPassword || userPassword

  const dir = await mkdtemp(join(tmpdir(), 'openbooks-pdf-'))
  const input = join(dir, 'in.pdf')
  const output = join(dir, 'out.pdf')
  try {
    await writeFile(input, pdf, { mode: 0o600 })
    // One argument per line, read from stdin: qpdf's @- form. Order matters —
    // --encrypt takes the user password, the owner password, the key length,
    // then its own options, terminated by `--`. Object streams stay off: with
    // them on, qpdf 12 hides document structure inside encrypted streams that
    // pdf-lib (which cannot decrypt) fails to walk, breaking the app's own
    // re-ingestion of protected files; plain object layout does not weaken
    // the AES-256 protection in any way.
    const args = [
      '--object-streams=disable',
      '--encrypt',
      userPassword,
      ownerPassword,
      '256',
      `--print=${options.allowPrinting === false ? 'none' : 'full'}`,
      `--extract=${options.allowExtraction === true ? 'y' : 'n'}`,
      '--',
      input,
      output,
    ]
    await runQpdf(args)
    const encrypted = await readFile(output)
    // Certify our own product before releasing it: qpdf must refuse to open
    // the result without the secret, so a broken or hostile qpdf can never
    // smuggle marker-only bytes out through this function as "encrypted".
    await verifyPdfEncryption(encrypted)
    return encrypted
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Certify that bytes are genuinely password-protected, independent of who
 * produced them.
 *
 * SECURITY: a parser-reported encryption flag is not evidence of encryption —
 * any writer can put an `/Encrypt` entry in the trailer dictionary of an
 * otherwise-plaintext file and every lenient parser will then report the
 * document as encrypted. Verification therefore asks qpdf — the same
 * authority the encryptor itself relies on — to open the document with an
 * EMPTY password:
 * - opens cleanly → whatever the markers claim, there is no protection;
 * - "invalid password" → a real security handler rejected the only
 *   credential a non-owner could have, so the payload is locked;
 * - anything else (malformed handler, unreadable file, missing binary) →
 *   certification is impossible and the caller must fail closed.
 *
 * A hand-crafted dict with internally consistent key material can still make
 * qpdf say "invalid password" over unencrypted streams — but such a file is
 * unreadable garbage to every spec-compliant viewer until it is given the
 * secret, so it leaks nothing; and the sanctioned producer below certifies its
 * own output with the live password before releasing it.
 */
export async function verifyPdfEncryption(pdf: Buffer | Uint8Array): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'openbooks-pdf-verify-'))
  const input = join(dir, 'candidate.pdf')
  try {
    await writeFile(input, pdf, { mode: 0o600 })
    let locked = false
    let failure: Error | null = null
    try {
      await runQpdf(['--check', input])
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // The empty-password attempt failing authentication is the one verdict
      // that proves protection; every other failure means we cannot certify.
      locked = /invalid password/i.test(message)
      if (!locked) failure = new Error(message)
    }
    if (locked) return
    if (failure) {
      throw new PdfEncryptionError(`the document could not be verified as encrypted (${failure.message})`)
    }
    throw new PdfEncryptionError('the document opens without a password')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** True when a qpdf binary is callable — for setup screens and diagnostics. */
export async function pdfEncryptionAvailable(): Promise<boolean> {
  try {
    await runQpdf(['--version'])
    return true
  } catch {
    return false
  }
}

function runQpdf(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // qpdf is provisioned by the runtime image (or the explicit environment
    // override), not a build asset. Without this annotation Turbopack treats
    // the dynamic executable as filesystem access and copies the whole
    // project into the standalone server output.
    const child = spawn(/* turbopackIgnore: true */ qpdfExecutable(), ['@-'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Bounded: a runaway diagnostic stream must not grow without limit.
      if (stderr.length < 4096) stderr += chunk
    })
    child.on('error', (error) => {
      reject(new PdfEncryptionError(
        `PDF encryption needs the qpdf binary (${(error as Error).message}) — install qpdf or set OPENBOOKS_QPDF_PATH`,
      ))
    })
    child.on('close', (code) => {
      // qpdf exit 3 is "completed with warnings", which still writes the file.
      if (code === 0 || code === 3) resolve()
      else reject(new PdfEncryptionError(`qpdf could not encrypt the document (exit ${code}): ${stderr.trim()}`))
    })
    child.stdin.on('error', () => {
      /* surfaced by the 'error'/'close' handlers above */
    })
    child.stdin.end(`${args.join('\n')}\n`)
  })
}
