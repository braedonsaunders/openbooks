import 'server-only'

import type { FeedbackHttpRequest } from '@braedonsaunders/appkit-feedback'

/**
 * Host egress for the issue tracker.
 *
 * The package never reaches the network itself — it hands the host a request
 * to make. That boundary is the point: this is the ONE place an issue report
 * leaves the deployment, so the bounds live here rather than in a library.
 *
 *   • the destination is pinned to api.github.com — a stored owner/repo can
 *     never become a request to another host;
 *   • redirects are refused: this request carries the operator's access
 *     token, which must not cross a redirect to whatever Location names;
 *   • the response is read with a byte ceiling, so a hostile or broken
 *     response cannot become unbounded memory in the request path.
 */

const GITHUB_API_ORIGIN = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024

export const feedbackGithubRequest: FeedbackHttpRequest = async (input) => {
  const url = new URL(input.url)
  if (url.origin !== GITHUB_API_ORIGIN) {
    throw new Error(`refusing an issue-tracker request to ${url.origin}`)
  }

  // Named for what it is: the package builds an Authorization bearer header
  // around the operator's sealed access token. Keeping that visible here is
  // what makes this call site auditable as credential-bearing
  // (scripts/check-credential-fetch-redirects.mjs).
  const authorization: Record<string, string> = input.headers
  const response = await fetch(url, {
    method: input.method,
    headers: authorization,
    body: input.body,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  const body = await readBounded(response)
  if (!response.ok) {
    // The status and a short excerpt, never the request body: that body is
    // the person's report, and the deployment log is not where it belongs.
    console.error(
      '[feedback/github]',
      input.method,
      url.pathname,
      response.status,
      body.replace(/\s+/g, ' ').trim().slice(0, 300),
    )
  }
  return { status: response.status, body }
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('the issue tracker returned an oversized response')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}
