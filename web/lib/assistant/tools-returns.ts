import 'server-only'

import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getReturnAuthorization, listReturnAuthorizations } from '@openbooks/engine/src/sales/returns.ts'
import type { Authz } from '../authz'
import type { AssistantToolDef, ToolResult } from './types'
import { uuidInput } from './tools-shared'

const listReturnsTool: AssistantToolDef = {
  name: 'list_return_authorizations',
  description: 'List customer return authorizations with status, lifecycle stage, authorized and received quantities, dispositions and linked credits. Read-only.',
  category: 'read',
  gate: { mode: 'anyOf', perms: ['orders.fulfill'] },
  feature: 'returnAuthorizations',
  inputSchema: z.object({}),
  execute: async (_raw, authz: Authz): Promise<ToolResult> => ({
    ok: true,
    data: { items: await listReturnAuthorizations(db, authz.user.orgId, authz.allowedSubsidiaryIds), href: '/returns' },
  }),
}

const getReturnTool: AssistantToolDef = {
  name: 'get_return_authorization',
  description: 'Read one return authorization by id, including its customer, source document, lifecycle stage, quantities and disposition records. Read-only.',
  category: 'read',
  gate: { mode: 'anyOf', perms: ['orders.fulfill'] },
  feature: 'returnAuthorizations',
  inputSchema: z.object({ id: uuidInput.describe('Return authorization id from list_return_authorizations') }),
  execute: async (raw, authz: Authz): Promise<ToolResult> => {
    const { id } = raw as { id: string }
    const authorization = await getReturnAuthorization(db, authz.user.orgId, id, authz.allowedSubsidiaryIds)
    return { ok: true, data: { ...authorization, href: '/returns' } }
  },
}

export const RETURNS_TOOLS: AssistantToolDef[] = [listReturnsTool, getReturnTool]
