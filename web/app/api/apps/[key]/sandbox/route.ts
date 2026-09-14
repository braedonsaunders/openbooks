import { NextResponse } from 'next/server'
import { guardFeaturePermission } from '@/lib/feature-gates'
import { applicationContextFromSession } from '@/lib/application/context'
import {
  getExtensionDraft,
  validateExtensionBundle,
} from '@/lib/application/extensions'
import { ApplicationError } from '@/lib/application/errors'
import { AppError, getAppByKey, getFrontendBundle } from '@/lib/apps/store'
import { contentTypeFor, parseManifest } from '@/lib/apps/manifest'
import { bridgeClientSource, inlineDocument } from '@/lib/apps/bridge'
import { APP_DOCUMENT_CSP } from '@/lib/apps/document-policy'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'
/** A separately served document avoids srcdoc inheriting the host's nonce CSP.
 * HTTP sandbox also enforces opaque origin when this URL is opened directly. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const query = new URL(request.url).searchParams
  const draftId = query.get('draft')
  const gate = await guardFeaturePermission(
    draftId ? 'apps.manage' : 'apps.use',
    'apps',
  )
  if (gate instanceof NextResponse) return gate
  try {
    const { key } = await params
    let bundle: {
      entry: string
      entryHtml: string
      replacements: Record<string, string>
    }
    let app: { id: string; key: string; name: string }
    if (draftId) {
      if (!isUuid(draftId))
        return NextResponse.json({ error: 'Invalid draft' }, { status: 400 })
      const draft = await getExtensionDraft(
        applicationContextFromSession(gate, 'api', crypto.randomUUID()),
        draftId,
      )
      const source = validateExtensionBundle(draft.bundle)
      const manifest = parseManifest(source.manifest).manifest!
      if (manifest.key !== key || manifest.frontend.renderer !== 'sandbox')
        return NextResponse.json(
          { error: 'App document not found' },
          { status: 404 },
        )
      const entry = source.files.find(
        (file) => file.path === manifest.frontend.entry,
      )!
      bundle = {
        entry: entry.path,
        entryHtml: entry.content,
        replacements: Object.fromEntries(
          source.files
            .filter(
              (file) =>
                file.path !== entry.path &&
                !manifest.endpoints.some(
                  (endpoint) => endpoint.file === file.path,
                ) &&
                !file.path.startsWith('objects/'),
            )
            .map((file) => [
              file.path,
              `data:${contentTypeFor(file.path).contentType.replace(/;\s*/g, ';')};base64,${file.isBinary ? file.content : Buffer.from(file.content).toString('base64')}`,
            ]),
        ),
      }
      app = { id: draft.id, key, name: manifest.name }
    } else {
      const installed = await getAppByKey(gate.user.orgId, key)
      if (!installed || installed.manifest?.frontend.renderer !== 'sandbox')
        return NextResponse.json(
          { error: 'App document not found' },
          { status: 404 },
        )
      bundle = await getFrontendBundle(
        gate.user.orgId,
        key,
        query.get('versionId') ?? undefined,
      )
      app = { id: installed.id, key, name: installed.name }
    }
    const context = {
      preview: Boolean(draftId),
      app,
      user: {
        id: gate.user.id,
        name: gate.user.name,
        roles: gate.user.roles.map((role) => role.key),
      },
    }
    const document = inlineDocument(
      bundle.entryHtml,
      bundle.replacements,
      `<script>${bridgeClientSource(context)}</script>`,
      bundle.entry,
    )
    return new Response(document, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': APP_DOCUMENT_CSP,
        'X-Frame-Options': 'SAMEORIGIN',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    })
  } catch (error) {
    if (error instanceof ApplicationError || error instanceof AppError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      )
    throw error
  }
}
