/** HR-20 shared error: every refusal names the remedy. */
export class FieldTimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FieldTimeError";
    this.code = code;
  }
}

/** Small helper: throw a named refusal. */
export function refuse(code: string, message: string): never {
  throw new FieldTimeError(code, message);
}
