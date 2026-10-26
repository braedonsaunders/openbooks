import "server-only";
import { KdfCapacityError } from "./auth-kdf-capacity";
import { hashPassword, replaceOwnPassword, type ReplaceOwnPasswordResult } from "./auth";
import { MIN_PASSWORD_LENGTH } from "./auth-reset";
import type { AuthRequestContext } from "./auth-policy";

/** Longest password the sign-in and reset paths accept. */
const MAX_PASSWORD_LENGTH = 1024;

export type PasswordPolicyRefusal = "weak_password" | "unchanged_password";

export type ChangeOwnPasswordResult =
  | ReplaceOwnPasswordResult
  | { ok: false; reason: PasswordPolicyRefusal }
  | { ok: false; reason: "busy" };

/**
 * The policy a new password must meet, judged before any credential work:
 * the same length bounds as a password reset, and different from the
 * current password.
 */
export function newPasswordPolicyRefusal(
  currentPassword: string,
  newPassword: string,
): PasswordPolicyRefusal | null {
  if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH)
    return "weak_password";
  if (newPassword === currentPassword) return "unchanged_password";
  return null;
}

/**
 * Change the signed-in identity's password. The policy is checked first, the
 * new hash is derived outside any transaction, and the replacement then
 * reauthenticates the current password under the sign-in rate limits and
 * lockout before it writes.
 */
export async function changeOwnPassword(input: {
  userId: string;
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  context: AuthRequestContext;
}): Promise<ChangeOwnPasswordResult> {
  const refusal = newPasswordPolicyRefusal(input.currentPassword, input.newPassword);
  if (refusal) return { ok: false, reason: refusal };
  let newPasswordHash: string;
  try {
    newPasswordHash = await hashPassword(input.newPassword);
  } catch (error) {
    if (error instanceof KdfCapacityError) return { ok: false, reason: "busy" };
    throw error;
  }
  return replaceOwnPassword({
    userId: input.userId,
    sessionId: input.sessionId,
    currentPassword: input.currentPassword,
    newPasswordHash,
    context: input.context,
  });
}
