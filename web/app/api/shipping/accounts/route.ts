import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@openbooks/engine/platform/database'
import { connectShippingAccount, listShippingAccounts } from '@openbooks/engine/sales/shipping-labels'
import { defineRoute } from '@/lib/api/route'

/** Carrier accounts with their health. Keys never leave sealed. */
export const GET = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  handler: async ({ authz }) => {
    const accounts = await listShippingAccounts(db, authz.user.orgId)
    return NextResponse.json({ accounts })
  },
})

const connectBody = z.object({
  accountId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  provider: z.enum(['easypost', 'shippo']),
  mode: z.enum(['test', 'live']),
  apiKey: z.string().max(500).nullable().optional(),
  makeDefault: z.boolean().optional(),
})

/**
 * Connect (or reconnect) a carrier account; the key is sealed on the way in.
 * A new account answers with its relay secret exactly once.
 */
export const POST = defineRoute({
  permission: 'shipping.manage',
  feature: 'shippingHub',
  body: connectBody,
  handler: async ({ authz, body }) => {
    const connected = await db.transaction((tx) =>
      connectShippingAccount(tx, authz.user.orgId, authz.user.id, {
        accountId: body.accountId,
        name: body.name,
        provider: body.provider,
        mode: body.mode,
        apiKey: body.apiKey,
        makeDefault: body.makeDefault,
      }),
    )
    return NextResponse.json({ connected })
  },
})
