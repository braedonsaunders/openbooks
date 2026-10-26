export class JournalInstructionError extends Error {
  readonly name = "JournalInstructionError";
  readonly status = 422;
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}
