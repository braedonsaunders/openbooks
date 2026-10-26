/**
 * Routes that stream stored file bytes for inline preview inside the app's
 * own drawers (PDF and image viewers). They are the only responses the app
 * may frame, and only from its own origin. Active content types are always
 * served as downloads by blobResponse, so a framed response is inert.
 */
const FRAMABLE_CONTENT_ROUTES = [
  /^\/api\/file-cabinet\/files\/[0-9a-f-]{36}\/download$/i,
  /^\/api\/ap-capture\/[0-9a-f-]{36}\/file$/i,
];

export function isFramableContentRequest(pathname: string, method: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    FRAMABLE_CONTENT_ROUTES.some((route) => route.test(pathname))
  );
}
