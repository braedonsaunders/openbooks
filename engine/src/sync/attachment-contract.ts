export interface AttachmentImportFailure {
  fileId: string;
  message: string;
}

export interface ImportSummary {
  /** all: every imported transaction; changes: the incremental mirror scope;
   * source_file_ids: an operator retry of named files. */
  scope: "all" | "changes" | "source_file_ids";
  /** Watermark of an incremental ("changes") scope. */
  changedSince?: string;
  requestedSourceFileIds: string[];
  sourceDocuments: number;
  sourceDocumentsWithoutId: number;
  /** Customers, vendors and employees whose Files subtabs were inventoried. */
  sourceParties?: number;
  /** Inventoried files the source reports no last-modified marker for. */
  filesWithoutSourceMarker?: number;
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
