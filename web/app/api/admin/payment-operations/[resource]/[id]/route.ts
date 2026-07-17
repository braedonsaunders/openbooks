import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { updatePaymentBankProfile } from '@openbooks/engine/src/payment-operations.ts'
import { computeNextRunAt } from '@openbooks/engine/src/scripting.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function PATCH(req: Request, { params }: { params: Promise<{ resource: string; id: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { resource, id } = await params
  if (!isUuid(id) || !['formats', 'profiles', 'schedules', 'mandates'].includes(resource)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, any>
  try {
    if (resource === 'profiles') {
      await updatePaymentBankProfile(id, gate.user.orgId, gate.user.id, body)
    } else if (resource === 'formats') {
      await db.execute(sql`
        update payment_formats set
          name = coalesce(${body.name?.trim() ?? null}, name),
          country = case when ${body.country === undefined} then country else ${body.country?.trim().toUpperCase() || null} end,
          currency = case when ${body.currency === undefined} then currency else ${body.currency?.trim().toUpperCase() || null} end,
          file_extension = coalesce(${body.fileExtension?.trim().replace(/^\./, '') ?? null}, file_extension),
          content_type = coalesce(${body.contentType?.trim() ?? null}, content_type),
          formatter_script = case when ${body.formatterScript === undefined} then formatter_script else ${body.formatterScript || null} end,
          is_active = coalesce(${body.isActive ?? null}, is_active), updated_at = now(), updated_by = ${gate.user.id}
        where id = ${id} and org_id = ${gate.user.orgId}
      `)
    } else if (resource === 'schedules') {
      const next = body.cron ? computeNextRunAt(body.cron) : undefined
      if (body.cron && !next) return NextResponse.json({ error: 'cron expression is invalid' }, { status: 400 })
      await db.execute(sql`
        update payment_schedules set
          name = coalesce(${body.name?.trim() ?? null}, name),
          payment_bank_profile_id = coalesce(${body.paymentBankProfileId ?? null}::uuid, payment_bank_profile_id),
          cron = coalesce(${body.cron?.trim() ?? null}, cron),
          timezone = coalesce(${body.timezone?.trim() ?? null}, timezone),
          selection_criteria = coalesce(${body.selectionCriteria ? JSON.stringify(body.selectionCriteria) : null}::jsonb, selection_criteria),
          action = coalesce(${body.action ?? null}, action),
          next_run_at = coalesce(${next ?? null}, next_run_at),
          is_active = coalesce(${body.isActive ?? null}, is_active), updated_at = now(), updated_by = ${gate.user.id}
        where id = ${id} and org_id = ${gate.user.orgId}
      `)
    } else {
      await db.execute(sql`
        update payment_mandates set
          status = coalesce(${body.status ?? null}, status),
          signed_on = case when ${body.signedOn === undefined} then signed_on else ${body.signedOn || null}::date end,
          valid_from = case when ${body.validFrom === undefined} then valid_from else ${body.validFrom || null}::date end,
          expires_on = case when ${body.expiresOn === undefined} then expires_on else ${body.expiresOn || null}::date end,
          updated_at = now(), updated_by = ${gate.user.id}
        where id = ${id} and org_id = ${gate.user.orgId}
      `)
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'request failed' }, { status: 422 })
  }
}
