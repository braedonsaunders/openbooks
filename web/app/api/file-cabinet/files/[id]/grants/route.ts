import { NextResponse } from 'next/server'
import { requireSession } from '../../../lib'
import { getGrants, postGrant } from '../../../grant-handlers'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  return getGrants(gate, 'file', id)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession()
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const body = await req.json().catch(() => null)
  return postGrant(gate, 'file', id, body)
}
