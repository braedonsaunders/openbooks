// Keep the post-login destination on this origin. Parsing against a fixed
// sentinel also catches backslash-normalized protocol-relative URLs such as
// `/\\evil.example`, which a browser would otherwise treat as cross-origin.
const SAFE_RETURN_TO_ORIGIN = "https://openbooks.invalid";

export function safeNextPath(value: string | null): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, SAFE_RETURN_TO_ORIGIN);
    if (parsed.origin !== SAFE_RETURN_TO_ORIGIN) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

/**
 * The `next` value for a sign-in redirect, built from the request's path and
 * raw query string. The query stays inside `next` so filters, date ranges and
 * drawer state survive sign-in. When the combined value is refused (for
 * example, an oversized query), the bare path is kept as the destination.
 */
export function loginReturnPath(pathname: string, search: string): string {
  const withQuery = safeNextPath(`${pathname}${search}`);
  if (withQuery !== "/") return withQuery;
  return safeNextPath(pathname);
}
