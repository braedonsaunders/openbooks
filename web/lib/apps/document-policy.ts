import { APP_CSP } from './bridge'

/** Only authenticated app documents receive the opaque-origin execution policy. */
export function isAppDocumentRequest(
  pathname: string,
  method: string,
): boolean {
  return (
    method === 'GET' && /^\/api\/apps\/[a-z][a-z0-9-]*\/sandbox$/.test(pathname)
  )
}
export const APP_DOCUMENT_CSP = `${APP_CSP}; sandbox allow-scripts; frame-ancestors 'self'`
