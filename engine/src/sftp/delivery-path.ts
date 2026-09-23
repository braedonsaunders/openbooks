import { assertSafePaymentFilename } from "../payments/payment-filenames.ts";
import { PaymentError } from "../payments/payment-errors.ts";
import { cleanPath } from "./backend.ts";

/**
 * Join the configured outbound folder and the artifact's file name into the
 * backend-relative publish path. The file name is re-validated here
 * (defence in depth — artifact creation already validates, but rows stored
 * before that guard must still fail closed at publish time), and after
 * normalization the result must still sit inside the folder: `cleanPath`
 * collapses dot segments, so without this check `outbound/../inbound/x`
 * would publish into the bank-feed folder while the delivery record claims
 * the outbound path.
 */
export function resolveOutboundPath(folder: string, filename: string): string {
  const safe = assertSafePaymentFilename(filename);
  const path = `${folder}/${safe}`;
  if (cleanPath(path) !== `/${path}`) {
    throw new PaymentError(
      `refusing SFTP delivery of ${JSON.stringify(safe)}: the resolved path escapes the configured outbound folder`,
    );
  }
  return path;
}
