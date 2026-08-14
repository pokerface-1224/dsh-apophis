// Temporary: extract the compiled getHtml() template literal, evaluate it, and
// syntax-check the resulting inline <script> with new Function().
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../dist/panel.js', import.meta.url), 'utf8')

const startMarker = 'return `'
const start = src.indexOf(startMarker)
if (start === -1) throw new Error('return ` not found')
const contentStart = start + startMarker.length
const endMarker = '</html>`'
const contentEnd = src.indexOf(endMarker, contentStart)
if (contentEnd === -1) throw new Error('closing </html>` not found')

const tpl = src.slice(contentStart, contentEnd)
const html = eval('`' + tpl.replace(/\$\{nonce\}/g, 'TESTNONCE') + '`')

const s = html.indexOf('<script')
const e = html.indexOf('</script>', s)
if (s === -1 || e === -1) throw new Error('script tag not found')
const inner = html.slice(s, e).replace(/^<script[^>]*>/, '')
new Function(inner) // throws on syntax error
console.log('WEBVIEW SCRIPT SYNTAX OK')
console.log('sample split line:', JSON.stringify(inner.match(/split\([^\n]+\)/)?.[0]))
console.log('sample safeUrl line:', JSON.stringify(inner.match(/safeUrl[^\n]*/)?.[0]?.slice(0, 60)))
