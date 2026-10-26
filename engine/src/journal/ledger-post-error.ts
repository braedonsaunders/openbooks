import { PostingError } from "./posting-contracts.ts";

/** A direct posting refused before or during its write, naming the refused value and the remedy. */
export class LedgerPostError extends PostingError {
  readonly name = "LedgerPostError";
}

export function fail(message: string): never {
  throw new LedgerPostError(message);
}
