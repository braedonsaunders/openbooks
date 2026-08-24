import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { encryptPdf, PdfEncryptionError, pdfEncryptionAvailable, verifyPdfEncryption } from './encrypt'

/**
 * Encryption is an external-binary capability (qpdf), exactly like the
 * Chromium renderer this package already depends on. The round trip is skipped
 * where the binary is absent; the fail-closed behaviour is always checked,
 * because that is the property confidential output depends on.
 */

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200]).drawText('net pay')
  return Buffer.from(await doc.save())
}

/**
 * A plaintext file wearing a forged `/Encrypt` trailer entry: every lenient
 * parser reports it as encrypted while the payload stays fully readable. This
 * is exactly the forgery the payroll send path must not be fooled by.
 */
async function forgedMarkerPdf(): Promise<Buffer> {
  const doc = await PDFDocument.load(await samplePdf())
  doc.context.trailerInfo.Encrypt = doc.context.register(
    doc.context.obj({
      Filter: 'Standard', V: 5, R: 6, Length: 256,
      O: '00', U: '00', OE: '00', UE: '00', P: -1, Perms: '00',
    }),
  )
  return Buffer.from(await doc.save())
}

test('qpdf is excluded from Turbopack filesystem tracing', () => {
  const source = readFileSync(new URL('./encrypt.ts', import.meta.url), 'utf8')
  assert.match(source, /spawn\(\/\* turbopackIgnore: true \*\/ qpdfExecutable\(\),/)
})

test('an empty password is refused', async () => {
  const pdf = await samplePdf()
  await assert.rejects(() => encryptPdf(pdf, { userPassword: '' }), PdfEncryptionError)
})

test('a missing qpdf binary throws instead of returning the plaintext', async () => {
  const pdf = await samplePdf()
  const previous = process.env.OPENBOOKS_QPDF_PATH
  process.env.OPENBOOKS_QPDF_PATH = '/nonexistent/qpdf-openbooks-test'
  try {
    await assert.rejects(
      () => encryptPdf(pdf, { userPassword: 'HOP12091906' }),
      (error: unknown) => {
        assert.ok(error instanceof PdfEncryptionError)
        assert.match((error as Error).message, /qpdf/)
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.OPENBOOKS_QPDF_PATH
    else process.env.OPENBOOKS_QPDF_PATH = previous
  }
})

test('encrypted output cannot be opened without the password', async () => {
  if (!(await pdfEncryptionAvailable())) {
    // qpdf is provisioned in the runtime image; developer machines may not
    // have it, and a skipped check is honest where a fake one is not.
    return
  }
  const encrypted = await encryptPdf(await samplePdf(), { userPassword: 'HOP12091906' })
  assert.match(encrypted.subarray(0, 5).toString('latin1'), /^%PDF-/)
  await assert.rejects(() => PDFDocument.load(encrypted))
  // Loading it while explicitly tolerating encryption still works, which is
  // how the ingestion paths in the app read third-party protected files.
  const parsed = await PDFDocument.load(encrypted, { ignoreEncryption: true })
  assert.equal(parsed.getPageCount(), 1)
})

test('genuine ciphertext passes certification', async () => {
  if (!(await pdfEncryptionAvailable())) return
  const encrypted = await encryptPdf(await samplePdf(), { userPassword: 'HOP12091906' })
  await assert.doesNotReject(() => verifyPdfEncryption(encrypted))
})

test('verification refuses a document that opens without a password', async () => {
  if (!(await pdfEncryptionAvailable())) return
  await assert.rejects(
    async () => verifyPdfEncryption(await samplePdf()),
    (error: unknown) => {
      assert.ok(error instanceof PdfEncryptionError)
      assert.match((error as Error).message, /opens without a password/)
      return true
    },
  )
})

test('a forged encryption marker does not certify plaintext as ciphertext', async () => {
  const forged = await forgedMarkerPdf()
  // The marker gullibility that makes the old parser-flag check unsafe: the
  // strict loader refuses to open it and reports it as encrypted.
  await assert.rejects(() => PDFDocument.load(forged), /encrypted/)
  const tolerant = await PDFDocument.load(forged, { ignoreEncryption: true })
  assert.equal(tolerant.isEncrypted, true)

  if (!(await pdfEncryptionAvailable())) return
  await assert.rejects(() => verifyPdfEncryption(forged), PdfEncryptionError)
})

test('verification fails closed when qpdf is unavailable', async () => {
  const pdf = await samplePdf()
  const previous = process.env.OPENBOOKS_QPDF_PATH
  process.env.OPENBOOKS_QPDF_PATH = '/nonexistent/qpdf-openbooks-test'
  try {
    await assert.rejects(
      () => verifyPdfEncryption(pdf),
      (error: unknown) => {
        assert.ok(error instanceof PdfEncryptionError)
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.OPENBOOKS_QPDF_PATH
    else process.env.OPENBOOKS_QPDF_PATH = previous
  }
})
