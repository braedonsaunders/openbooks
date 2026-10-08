import type { MetadataRoute } from 'next'

/** Installation identity is stable across organizations, sessions and releases. */
export function appManifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'OpenBooks',
    short_name: 'OpenBooks',
    description: 'Accounting and business management with OpenBooks.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f766e',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/** Public installation metadata contains no organization or employee information. */
export function employeeManifest(): MetadataRoute.Manifest {
  return {
    id: '/me',
    name: 'OpenBooks',
    short_name: 'OpenBooks',
    start_url: '/me',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f766e',
    icons: [
      { src: '/employee-app/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/employee-app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
