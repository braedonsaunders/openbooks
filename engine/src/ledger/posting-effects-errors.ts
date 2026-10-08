/**
 * Posting-effects refusals. Kept free of imports so API response mapping can
 * recognize them without loading the posting dispatcher and its dependencies.
 */

export class PostingEffectsTerminalFailureError extends Error {
  constructor(documentId: string) {
    super(`posting effects for document ${documentId} require operator remediation`);
    this.name = "PostingEffectsTerminalFailureError";
  }
}

export class PostingEffectsReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingEffectsReplayError";
  }
}

export class PostingEffectsLeaseFencedError extends Error {
  constructor(id: string) {
    super(`posting-effects claim ${id} lost its lease and was fenced`);
    this.name = "PostingEffectsLeaseFencedError";
  }
}
