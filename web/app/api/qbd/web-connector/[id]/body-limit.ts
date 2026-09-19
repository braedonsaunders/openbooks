/** Largest SOAP envelope accepted. Response documents carry whole company
 *  query results, so the cap is generous — but it is enforced on the actual
 *  streamed bytes, not on the sender-declared content-length (absent on
 *  chunked uploads), so an unbounded body can never be buffered. */
export const QBD_MAX_BODY_BYTES = 256 * 1024 * 1024
