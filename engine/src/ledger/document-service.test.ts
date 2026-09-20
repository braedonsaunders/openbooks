import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentEditError } from '../records/document-edit-policy.ts'
import { controlDeps, loadDocument, loadDocumentEditCurrent } from './document-service.ts'

test('document service refuses missing organization before attempting any read', async () => {
  for (const orgId of [undefined, null, '', '   ']) {
    // Exercise JavaScript/untyped callers as well as the required TS argument.
    const omitted = orgId as unknown as string
    for (const read of [() => loadDocument('document', omitted),
      () => loadDocumentEditCurrent('document', omitted), () => controlDeps(omitted)]) {
      await assert.rejects(read, (error: unknown) => error instanceof DocumentEditError
        && error.status === 422 && /supply the document organization explicitly/.test(error.message))
    }
  }
})
