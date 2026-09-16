import { NextResponse } from 'next/server'
import {
  acceptWebConnectorResponse,
  authenticateWebConnector,
  closeWebConnectorSession,
  nextWebConnectorRequest,
  recordConnectionError,
  webConnectorLastError,
} from '@openbooks/engine/src/qbd/bridge.ts'
import { firstNode, hasNode, parseXml, xmlEscape } from '@openbooks/engine/src/qbd/qbxml.ts'
import { readBoundedBodyText } from '../../../../../lib/bounded-body'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Largest SOAP envelope accepted. Response documents carry whole company
 *  query results, so the cap is generous — but it is enforced on the actual
 *  streamed bytes, not on the sender-declared content-length (absent on
 *  chunked uploads), so an unbounded body can never be buffered. */
export const QBD_MAX_BODY_BYTES = 256 * 1024 * 1024

const NS = 'http://developer.intuit.com/'

function value(node: Record<string, unknown>, key: string): string {
  const raw = node[key]
  if (raw && typeof raw === 'object' && '#text' in (raw as Record<string, unknown>)) {
    return String((raw as Record<string, unknown>)['#text'] ?? '')
  }
  return raw == null ? '' : String(raw)
}

function envelope(body: string): Response {
  const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`
  return new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } })
}

function scalar(method: string, result: string): Response {
  return envelope(`<${method}Response xmlns="${NS}"><${method}Result>${xmlEscape(result)}</${method}Result></${method}Response>`)
}

function fault(message: string): Response {
  return envelope(`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${xmlEscape(message)}</faultstring></soap:Fault>`)
}

export async function GET() {
  return NextResponse.json({ service: 'QuickBooks Desktop Web Connector', ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const bounded = await readBoundedBodyText(req, QBD_MAX_BODY_BYTES)
  if (!bounded.ok) {
    if (bounded.reason === 'too_large') {
      return new Response('QuickBooks response exceeds the 256 MiB safety limit', { status: 413 })
    }
    return fault('Malformed SOAP XML')
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parseXml(bounded.text)
  } catch {
    return fault('Malformed SOAP XML')
  }

  // Presence-dispatched: handshake elements are childless or text-only, so
  // firstNode (object-valued nodes only) never matches them.
  if (hasNode(parsed, 'serverVersion')) return scalar('serverVersion', '1.0.0')
  if (hasNode(parsed, 'clientVersion')) return scalar('clientVersion', '')

  const auth = firstNode(parsed, 'authenticate')
  if (auth) {
    const result = await authenticateWebConnector(id, value(auth, 'strUserName'), value(auth, 'strPassword'))
    return envelope(`<authenticateResponse xmlns="${NS}"><authenticateResult><string>${xmlEscape(result.ticket)}</string><string>${xmlEscape(result.companyFile)}</string></authenticateResult></authenticateResponse>`)
  }

  const send = firstNode(parsed, 'sendRequestXML')
  if (send) {
    const requestXml = await nextWebConnectorRequest(value(send, 'ticket'), {
      companyFile: value(send, 'strCompanyFileName') || undefined,
      country: value(send, 'qbXMLCountry') || undefined,
      qbxmlMajor: Number(value(send, 'qbXMLMajorVers')) || undefined,
      qbxmlMinor: Number(value(send, 'qbXMLMinorVers')) || undefined,
    })
    return scalar('sendRequestXML', requestXml)
  }

  const receive = firstNode(parsed, 'receiveResponseXML')
  if (receive) {
    const progress = await acceptWebConnectorResponse(
      value(receive, 'ticket'),
      value(receive, 'response'),
      value(receive, 'hresult'),
      value(receive, 'message'),
    )
    return scalar('receiveResponseXML', String(progress))
  }

  const lastError = firstNode(parsed, 'getLastError')
  if (lastError) return scalar('getLastError', await webConnectorLastError(value(lastError, 'ticket')))

  const close = firstNode(parsed, 'closeConnection')
  if (close) return scalar('closeConnection', await closeWebConnectorSession(value(close, 'ticket')))

  const connectionError = firstNode(parsed, 'connectionError')
  if (connectionError) {
    return scalar('connectionError', await recordConnectionError(
      value(connectionError, 'ticket'),
      value(connectionError, 'hresult'),
      value(connectionError, 'message'),
    ))
  }

  return fault('Unsupported QuickBooks Web Connector method')
}
