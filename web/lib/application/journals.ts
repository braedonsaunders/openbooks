import "server-only";
import {
  createManualJournal,
  journalCreateBody,
  JournalCreateError,
  type JournalCreateBody,
} from "../journal-create";
import { isUuid } from "../list-params";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput } from "./errors";

export { journalCreateBody };
export type { JournalCreateBody };

function journalFailure(error: unknown): never {
  if (error instanceof JournalCreateError) {
    const code = error.status === 404
      ? "not_found"
      : error.status === 409
        ? "conflict"
        : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, error.payload);
  }
  throw error;
}

/** Balanced-line journal create — same writer as POST /api/journals. */
export async function createApplicationJournal(
  context: ApplicationContext,
  input: { idempotencyKey: string; body: JournalCreateBody },
): Promise<{ created: boolean; journal: Record<string, unknown>; replayed: boolean }> {
  assertApplicationPermission(context, "gl.post");
  if (!isUuid(input.idempotencyKey)) {
    throw new ApplicationError("invalid_input", "invalid_idempotency_key", 400);
  }
  try {
    const result = await createManualJournal({
      orgId: context.authz.user.orgId,
      userId: context.authz.user.id,
      allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      idempotencyKey: input.idempotencyKey,
      body: input.body,
    });
    return {
      created: result.created,
      journal: result.journal as unknown as Record<string, unknown>,
      replayed: !result.created,
    };
  } catch (error) {
    journalFailure(error);
  }
}

export function parseJournalCreateBody(body: Record<string, unknown>): JournalCreateBody {
  const parsed = journalCreateBody.safeParse(body);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

export function requireUuidIdempotencyKey(key: string): string {
  if (!isUuid(key)) throw invalidInput("Idempotency-Key must be a UUID — it becomes the journal id");
  return key;
}
