import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
import { reopenDocument, ReopenError } from '@openbooks/engine/src/document-edit.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return { control: { ar: c.ar, ap: c.ap, bank: c.bank, taxCollected: c.taxCollected, taxPaid: c.taxPaid } }
}

/**
 * Manual-journal actions. v1 posts straight from draft (no approval policy);
 * the switch mirrors the bills actions route so submit/decide can slot in
 * when a journal approval policy exists.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { action: string; documentId?: string }

  try {
    switch (body.action) {
      case 'post': {
        const gate = await guardPermission('gl.post')
        if (gate instanceof NextResponse) return gate
        if (!body.documentId) {
          return NextResponse.json({ error: 'documentId required' }, { status: 400 })
        }
        const owned = (await db.execute(sql`
          select id from documents
           where id = ${body.documentId} and kind = 'journal' and org_id = ${gate.user.orgId}
        `)) as unknown as { rows: { id: string }[] }
        if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

        // postDocument enforces balance (kernel + rule check) and throws on failure
        const entryId = await postDocument(body.documentId, await controlDeps(gate.user.orgId))
        return NextResponse.json({ ok: true, entryId })
      }
      case 'reopen': {
        const gate = await guardPermission('gl.post')
        if (gate instanceof NextResponse) return gate
        if (!body.documentId) {
          return NextResponse.json({ error: 'documentId required' }, { status: 400 })
        }
        const owned = (await db.execute(sql`
          select id from documents
           where id = ${body.documentId} and kind = 'journal' and org_id = ${gate.user.orgId}
        `)) as unknown as { rows: { id: string }[] }
        if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
        const res = await reopenDocument(body.documentId, gate.user.id)
        return NextResponse.json({ ok: true, id: res.documentId })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    const status = e instanceof PostingError || e instanceof ReopenError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
