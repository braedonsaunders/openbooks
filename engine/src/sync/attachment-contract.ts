export interface AttachmentImportFailure {
  fileId: string;
  message: string;
}

export interface ImportSummary {
  scope: "all" | "source_file_ids";
  requestedSourceFileIds: string[];
  sourceDocuments: number;
  sourceDocumentsWithoutId: number;
  sourceFiles: number;
  sourceLinks: number;
  createdFiles: number;
  newVersions: number;
  unchangedFiles: number;
  /** Already-imported files skipped without download when the source marker
   * matches a complete stored version. */
  skippedUnchanged: number;
  createdLinks: number;
  failures: number;
  failureDetails: AttachmentImportFailure[];
}

export class AttachmentImportError extends Error {
  constructor(public readonly summary: ImportSummary) {
    super(`${summary.failures} source files failed to import`);
    this.name = "AttachmentImportError";
  }
}

