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
    // then its own options, terminated by `--`.
    const args = [
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
    return await readFile(output)
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
    const child = spawn(qpdfExecutable(), ['@-'], { stdio: ['pipe', 'ignore', 'pipe'] })
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
