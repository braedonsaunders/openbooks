import { employeeManifest } from '../../../lib/pwa-manifest'

/** Browser installation reads only public branding; no session or tenant data is resolved. */
export function GET(): Response {
  return Response.json(employeeManifest(), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
