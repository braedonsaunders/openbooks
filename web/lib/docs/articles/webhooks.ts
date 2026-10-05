import type { DocArticle } from '../types'

export const webhooks: DocArticle = {
  slug: 'webhooks',
  title: 'Webhooks',
  category: 'administration',
  order: 13,
  summary:
    'Subscribe URLs to signed domain events — postings, payments, customers, stock — with retried delivery, signature verification, rotation, and an automation action.',
  updated: '2026-10-05',
  keywords: ['webhook', 'endpoint', 'signature', 'HMAC', 'delivery', 'retry', 'rotation', 'subscriber', 'domain event'],
  related: ['automations', 'app-api-reference', 'setup-company-group'],
  body: `# Webhooks

Webhooks deliver signed domain events to subscriber URLs: postings and voids, payments received, item and customer updates, overdue invoices, stock availability changes, subscription changes, and storefront order exceptions. Each delivery POSTs a JSON envelope and retries with backoff when the receiver is down, so integrations stay in sync without polling.

Enable the module in Company Settings → Features → Outbound webhooks (needs API access). While the feature is off, endpoints hide and new deliveries stop; stored endpoints and history resume when it returns.

## Subscribing an endpoint

Go to Settings → Developers → Webhooks and choose New endpoint. Give it a stable endpoint key (lowercase letters, digits, dashes and underscores — recipes address the endpoint by this key and it never changes), the public **https** subscriber URL, and the event types it receives. The signing secret appears ONCE after creation: copy it into the receiver's secret store immediately, because the loader never shows plaintext again.

The list shows every endpoint with its status badge, failure streak, last delivery, and event count. Reading needs the webhooks read grant; creating, editing, rotating and redelivering need the webhooks manage grant.

## Delivery policy

Failed attempts retry with exponential backoff and jitter for 3 days, then the delivery goes dead. A 410 (Gone) response disables the endpoint at once. After too many consecutive failures the endpoint disables automatically, which writes an audit event and notifies administrators — re-enable it from the drawer once the receiver is healthy. The endpoint drawer Deliveries tab lists every attempt with event, status badge, attempts, response code, latency and next attempt; open a row for the payload and the response excerpt, and redeliver the failed ones from the row menu.

Security tab: rotate the signing secret with confirmation. After a rotation the old secret stays valid for in-flight deliveries (both signatures are sent until the next rotation), and a test ping sends an **endpoint.tested** event on demand.

## Verifying signatures

Every POST carries **OpenBooks-Event** (the event name), **OpenBooks-Delivery** (the delivery id), and **OpenBooks-Signature** headers. The signature value is **t=<unix time>,v1=<hex>**, where **<hex>** is the lowercase hex HMAC-SHA256 of the string **timestamp + "." + raw JSON body**, keyed with the endpoint secret. During a rotation overlap a second **v1=** value signed with the previous secret is appended — accept the delivery when ANY value verifies. Recompute the HMAC over the raw body bytes (before JSON parsing) and compare in constant time; reject when the timestamp is more than a few minutes old.

Node verification:

~~~js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifyWebhook(secret, rawBody, signature) {
  const values = signature.split(',').slice(1)
  return values.some((entry) => {
    const [version, hex] = entry.split('=')
    if (version !== 'v1') return false
    const timestamp = signature.split(',')[0].slice(2)
    const expected = createHmac('sha256', secret).update(timestamp + '.' + rawBody, 'utf8').digest('hex')
    const a = Buffer.from(hex, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  })
}
~~~

Python verification:

~~~python
import hashlib
import hmac

def verify_webhook(secret: str, raw_body: bytes, signature: str) -> bool:
    parts = signature.split(',')
    timestamp = parts[0][2:]
    for entry in parts[1:]:
        version, _, hex_digest = entry.partition('=')
        if version != 'v1':
            continue
        expected = hmac.new(
            secret.encode('utf-8'),
            timestamp.encode('utf-8') + b'.' + raw_body,
            hashlib.sha256,
        ).hexdigest()
        if hmac.compare_digest(hex_digest, expected):
            return True
    return False
~~~

## Recipes calling out

Automation recipes gain a **webhook** action (the builder offers it once the feature is on). The action names the subscriber by its endpoint key — **endpointKey** — and the run delivers the recipe event through the same signed transport, with the same retries and run-log rows. When the feature is off or the endpoint is missing or disabled, the run refuses naming Settings → Developers → Webhooks as the remedy.
`,
}
