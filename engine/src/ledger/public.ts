/** Supported document command/read contract for application adapters. */
export { createPostedCorrection, correctPostedDocument, planPostedCorrection, PostedCorrectionError, type CorrectPostedDocumentResult, type CorrectionContext, type CorrectionDraftWriter } from './document-correction.ts'
export { loadDocument, loadDocumentEditCurrent, controlDeps } from './document-service.ts'
export type { DocumentEditInput, DocumentLineInput, DocumentEditCurrent } from './document-input.ts'
export { postDocument } from './posting-document.ts'
export { requestDocumentVoid, DocumentVoidError } from './document-void.ts'
export { DocumentEditError } from '../records/document-edit-policy.ts'
