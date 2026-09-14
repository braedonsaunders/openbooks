'use client'

import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'

/** The source editor shared by governed scripts and app package files. */
export function CodeEditor({
  value,
  onChange,
  path = 'script.js',
  readOnly = false,
}: {
  value: string
  onChange: (value: string) => void
  path?: string
  readOnly?: boolean
}) {
  const language = /\.json$/i.test(path)
    ? json()
    : /\.css$/i.test(path)
      ? css()
      : /\.html?$/i.test(path)
        ? html()
        : javascript({
            typescript: /\.tsx?$/i.test(path),
            jsx: /\.[jt]sx$/i.test(path),
          })
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={[language]}
        theme="dark"
        minHeight="420px"
        maxHeight="640px"
        readOnly={readOnly}
        editable={!readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          autocompletion: true,
        }}
      />
    </div>
  )
}
