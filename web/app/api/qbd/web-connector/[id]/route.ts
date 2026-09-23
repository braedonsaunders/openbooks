import { NextResponse } from 'next/server'
import {
  acceptWebConnectorResponse,
  authenticateWebConnector,
  closeWebConnectorSession,
  isWebConnectorTicketOpen,
  nextWebConnectorRequest,
  recordConnectionError,
  webConnectorLastError,
} from '@openbooks/engine/src/qbd/bridge.ts'
import { assertSoapEnvelopeComplexity, firstNode, hasNode, identifyQbdSoapCall, parseXml, QBD_PREAUTH_MAX_BYTES, xmlEscape } from '@openbooks/engine/src/qbd/qbxml.ts'
import { QBD_MAX_BODY_BYTES } from './body-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

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

function fault(message: string, status = 200): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>${xmlEscape(message)}</faultstring></soap:Fault></soap:Body></soap:Envelope>`,
    { status, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } },
  )
}

function oversizedRefusal(): Response {
  return fault('QuickBooks request exceeds the 64 KiB unauthenticated limit; only a ticket-authenticated receiveResponseXML may stream up to 256 MiB', 413)
}

type HeadRead =
  | { ok: true; text: string; complete: true }
  | { ok: true; text: string; complete: false; reader: ReadableStreamDefaultReader<Uint8Array>; decoder: TextDecoder; bytes: number }
  | { ok: false }

/**
 * Stream at most the pre-auth head (64 KiB). The accumulation never holds
 * more than the head plus one in-flight chunk until the caller proves the
 * call is a ticket-authenticated receiveResponseXML — an unauthenticated
 * client cannot make the endpoint buffer or parse bulk.
 */
async function readHead(req: Request, maxBytes: number): Promise<HeadRead> {
  const body = req.body
  if (!body) return { ok: true, text: '', complete: true }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        reader.releaseLock()
        return { ok: true, text, complete: true }
      }
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (bytes > maxBytes) return { ok: true, text, complete: false, reader, decoder, bytes }
    }
  } catch {
    await reader.cancel().catch(() => undefined)
    return { ok: false }
  }
}

/** Continue a gated stream up to the large cap after the ticket checked out. */
async function readRemainder(head: Extract<HeadRead, { complete: false }>, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  let { text, bytes } = { text: head.text, bytes: head.bytes }
  try {
    for (;;) {
      const { done, value } = await head.reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await head.reader.cancel().catch(() => undefined)
        return { ok: false }
      }
      text += head.decoder.decode(value, { stream: true })
    }
  } catch {
    await head.reader.cancel().catch(() => undefined)
    return { ok: false }
  } finally {
    head.reader.releaseLock()
  }
  text += head.decoder.decode()
  return { ok: true, text }
}

function parseEnvelope(text: string): Record<string, unknown> | Response {
  try {
    assertSoapEnvelopeComplexity(text)
  } catch (error) {
    return fault(error instanceof Error ? error.message : 'Malformed SOAP XML', 400)
  }
  try {
    return parseXml(text)
  } catch {
    return fault('Malformed SOAP XML')
  }
}

export async function GET() {
  return NextResponse.json({ service: 'QuickBooks Desktop Web Connector', ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // A sender-declared length is never trusted for acceptance, but it does
  // justify an early refusal above the absolute cap — even a live ticket's
  // receiveResponseXML cannot exceed it.
  const declared = req.headers.get('content-length')
  if (declared != null && declared.trim() !== '') {
    const length = Number(declared)
    if (Number.isSafeInteger(length) && length > QBD_MAX_BODY_BYTES) {
      return fault('QuickBooks response exceeds the 256 MiB safety limit', 413)
    }
  }
  const head = await readHead(req, QBD_PREAUTH_MAX_BYTES)
  if (!head.ok) return fault('Malformed SOAP XML')
  if (head.complete) {
    const parsed = parseEnvelope(head.text)
    if (parsed instanceof Response) return parsed
    return dispatch(id, parsed)
  }
  // Oversized: identify the method and ticket from the bounded head and
  // authenticate BEFORE buffering the rest. Anything but a live ticket's
  // receiveResponseXML is refused with 413 here, having buffered only the
  // head — never the full body, and never a full parse.
  const call = identifyQbdSoapCall(head.text)
  if (call?.method !== 'receiveResponseXML' || !call.ticket || !(await isWebConnectorTicketOpen(call.ticket))) {
    await head.reader.cancel().catch(() => undefined)
    return oversizedRefusal()
  }
  const rest = await readRemainder(head, QBD_MAX_BODY_BYTES)
  if (!rest.ok) {
    return fault('QuickBooks response exceeds the 256 MiB safety limit', 413)
  }
  const parsed = parseEnvelope(rest.text)
  if (parsed instanceof Response) return parsed
  return dispatch(id, parsed)
}

async function dispatch(id: string, parsed: Record<string, unknown>): Promise<Response> {

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
