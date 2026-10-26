/** Signals that another mutating run already owns the connection. */
export class SyncRunAlreadyActiveError extends Error {
  constructor(kind: string) {
    super(`a mutating sync run is already active for this connection (requested ${kind})`);
    this.name = "SyncRunAlreadyActiveError";
  }
}

/** Shared advisory-lock identity for every mutating run on one connection. */
export function syncConnectionRunLockKey(connectionId: string): string {
  return `sync-run:${connectionId}`;
}

/** Refuses tax-bearing source lines without a resolved tax code before writing the document. */
export class SyncTaxCodeError extends Error {
  constructor(sourceRef: string, lineNumber: number, taxAmount: string) {
    super(
      `source transaction ${sourceRef} line ${lineNumber} carries tax amount ${taxAmount} with no resolved tax code`,
    );
    this.name = "SyncTaxCodeError";
  }
}
