import type { Config } from 'tailwindcss'
import forms from '@tailwindcss/forms'
import typography from '@tailwindcss/typography'

export default {
  content: [
    './app/**/*.{ts,tsx,mdx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../packages/ui/src/**/*.{ts,tsx}',
    // AppKit packages ship compiled JS; their utility classes must be
    // scanned or the schedule surface renders unstyled.
    '../node_modules/@braedonsaunders/appkit-*/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Helvetica', 'Arial'],
      },
    },
  },
  plugins: [forms, typography],
} satisfies Config
