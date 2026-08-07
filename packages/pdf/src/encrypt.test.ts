import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { encryptPdf, PdfEncryptionError, pdfEncryptionAvailable } from './encrypt'

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
