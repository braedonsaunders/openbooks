import type { MetadataRoute } from 'next'

/** Public installation metadata contains no organization or employee information. */
export default function manifest(): MetadataRoute.Manifest {
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
      { src: '/employee-app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
