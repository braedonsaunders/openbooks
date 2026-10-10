/**
 * Credential placeholder for an invited user who has not set a password yet.
 *
 * The row carries this value until the mailbox owner follows the one-use
 * set-password link issued through the password-reset path. It is
 * deliberately NOT a parseable hash: password verification fails closed on
 * it (no KDF, no match), so no presented secret can ever authenticate. The
 * same value marks an invitation as still pending, which is what lets an
 * administrator re-issue its link.
 */
export const UNUSABLE_PASSWORD_HASH = "unusable";
