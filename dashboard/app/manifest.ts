import type { MetadataRoute } from 'next';

/**
 * Web app manifest (served at /manifest.webmanifest, linked automatically).
 * Makes the dashboard installable as a desktop app from Chrome/Edge on
 * Windows, macOS and Linux (and "Add to Dock" in Safari on macOS).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Smart Control',
    short_name: 'Smart Control',
    description: 'Control your Smart Control switches, schedules and household.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    background_color: '#101827',
    theme_color: '#101827',
    categories: ['utilities', 'productivity', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Overview', url: '/', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Schedules', url: '/schedules', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Usage', url: '/usage', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
