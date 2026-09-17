/**
 * Invite-user helpers for `POST /api/admin/users` (`action: "invite"`).
 *
 * An invited user has no password yet: the row carries an unusable
 * credential placeholder until the mailbox owner follows the set-password
 * link issued through the password-reset mail path. The placeholder is
 * deliberately NOT a parseable hash — `verifyPassword` fails closed on it
 * (no scrypt, no match), so no presented secret can ever authenticate.
 * This mirrors the `'x'` placeholder the test fixtures already use.
 */
export const UNUSABLE_PASSWORD_HASH = "unusable";

/**
 * Display name for a freshly invited user, derived from the (already
 * normalized) email local part: `jane.doe+payroll@…` → `Jane Doe`. Falls
 * back to the full address when nothing is derivable.
 */
export function deriveInviteDisplayName(email: string): string {
  const local = email.split("@")[0] ?? "";
  const base = local.split("+")[0] ?? "";
  const words = base
    .split(/[._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  if (words.length === 0) return email;
  return words.join(" ");
}
