import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { getConnection } from '@openbooks/engine/src/sync/connection.ts'
import { xmlEscape } from '@openbooks/engine/src/qbd/qbxml.ts'
import { guardPermission } from '../../../../../../lib/authz'

export const runtime = 'nodejs'

const OWNER_ID = '{E71D62A6-BC4D-4F72-90E8-F797CA478DA0}'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const connection = await getConnection(gate.user.orgId, id)
  if (!connection) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (connection.source !== 'qbd') return NextResponse.json({ error: 'not a QuickBooks Desktop connection' }, { status: 400 })

  const origin = new URL(req.url).origin
  if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
    return NextResponse.json({ error: 'QuickBooks Web Connector requires an HTTPS deployment URL' }, { status: 400 })
  }
  const endpoint = `${origin}/api/qbd/web-connector/${connection.id}`
  const support = `${origin}/docs/quickbooks-desktop-connector`
  const fileId = `{${connection.id.toUpperCase()}}`
  const username = `qbd:${connection.id}`
  const t = await getTranslations('sync')
  const xml = `<?xml version="1.0"?>
<QBWCXML>
  <AppName>${xmlEscape(connection.displayName)}</AppName>
  <AppID></AppID>
  <AppURL>${xmlEscape(endpoint)}</AppURL>
  <AppDescription>${xmlEscape(t('qbd.qwcDescription'))}</AppDescription>
  <AppSupport>${xmlEscape(support)}</AppSupport>
  <UserName>${xmlEscape(username)}</UserName>
  <OwnerID>${OWNER_ID}</OwnerID>
  <FileID>${fileId}</FileID>
  <QBType>QBFS</QBType>
  <Scheduler><RunEveryNMinutes>5</RunEveryNMinutes></Scheduler>
  <IsReadOnly>true</IsReadOnly>
  <UnattendedModePref>umpOptional</UnattendedModePref>
  <PersonalDataPref>pdpOptional</PersonalDataPref>
  <Style>Document</Style>
  <AuthFlags>0xF</AuthFlags>
</QBWCXML>`
  const safeName = connection.displayName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'quickbooks-desktop'
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}.qwc"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
