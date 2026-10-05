import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { appBaseUrl } from '@openbooks/engine/src/flows/email-tokens.ts'
import { CommerceError } from '@openbooks/engine/src/commerce/errors.ts'
import {
  completeShopifyOAuth,
  SHOPIFY_OAUTH_COOKIE,
} from '@openbooks/engine/src/commerce/shopify/connect.ts'

export const maxDuration = 300

/**
 * Shopify OAuth callback: the engine rechecks HMAC, state, nonce and the
 * shop behind the round-trip before the token is stored, then finishes
 * the connection (webhooks, import) and lands on the review. Like the
 * accounting-connection callbacks, failures bounce to the connect page
 * with a code instead of rendering an error.
 */
function bounce(code: string): NextResponse {
  const response = NextResponse.redirect(new URL(`/channels/connect?oauth=${code}`, `${appBaseUrl()}/`))
  response.cookies.set(SHOPIFY_OAUTH_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/api/channels/shopify/oauth' })
  return response
}

function cookieNonce(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) !== SHOPIFY_OAUTH_COOKIE) continue
    try {
      return decodeURIComponent(trimmed.slice(eq + 1))
    } catch {
      return trimmed.slice(eq + 1)
    }
  }
  return null
}

export const GET = defineRoute({
  permission: 'channels.manage',
  feature: 'salesChannels',
  scope: 'unrestricted',
  handler: async ({ request: req, authz: gate }) => {
    const url = new URL(req.url)
    if (url.searchParams.get('error')) return bounce('denied')
    const query: Record<string, string | undefined> = {}
    url.searchParams.forEach((value, key) => {
      query[key] = value
    })
    try {
      const { channelId } = await completeShopifyOAuth(gate.user.orgId, {
        query,
        cookieNonce: cookieNonce(req),
        actorId: gate.user.id,
        webOrigin: appBaseUrl(),
      })
      const response = NextResponse.redirect(new URL(`/channels/${channelId}?connected=1`, `${appBaseUrl()}/`))
      response.cookies.set(SHOPIFY_OAUTH_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/api/channels/shopify/oauth' })
      return response
    } catch (error) {
      if (error instanceof CommerceError) return bounce(error.code)
      throw error
    }
  },
})
