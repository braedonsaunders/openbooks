// Keep the post-login destination on this origin. Parsing against a fixed
// sentinel also catches backslash-normalized protocol-relative URLs such as
// `/\\evil.example`, which a browser would otherwise treat as cross-origin.
const SAFE_RETURN_TO_ORIGIN = 'https://openbooks.invalid'

export function safeNextPath(value: string | null): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return '/'
  try {
    const parsed = new URL(value, SAFE_RETURN_TO_ORIGIN)
    if (parsed.origin !== SAFE_RETURN_TO_ORIGIN) return '/'
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return '/'
  }
}
