/**
 * Chat webview panel for the dsh VS Code extension.
 *
 * Renders a minimal chat UI (user/assistant bubbles, a status badge, a
 * collapsible server log, and a prompt input) and forwards user actions back to
 * the extension. Assistant output is streamed as plain text (no markdown
 * rendering in this MVP).
 */

import * as vscode from 'vscode'

export type PanelStatus = 'idle' | 'starting' | 'ready' | 'busy' | 'stopped' | 'error'

export interface PanelHandlers {
  send(text: string): void
  cancel(): void
  restart(): void
  stop(): void
  newChat(): void
}

function getNonce(): string {
  let text = ''
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length))
  return text
}

export class ChatPanel {
  public static current: ChatPanel | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly disposables: vscode.Disposable[] = []

  public static createOrShow(context: vscode.ExtensionContext, handlers: PanelHandlers): ChatPanel {
    const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(column)
      return ChatPanel.current
    }
    const panel = vscode.window.createWebviewPanel('dsh.chat', 'DeepSeek Harness', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    })
    ChatPanel.current = new ChatPanel(panel, context, handlers)
    return ChatPanel.current
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, private readonly handlers: PanelHandlers) {
    this.panel = panel
    this.panel.webview.html = this.getHtml()
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables,
    )
    context.subscriptions.push(this.panel)
  }

  private dispose(): void {
    if (ChatPanel.current === this) ChatPanel.current = undefined
    while (this.disposables.length > 0) this.disposables.pop()!.dispose()
    this.panel.dispose()
  }

  private handleMessage(message: { type: string; text?: string; url?: string }): void {
    switch (message.type) {
      case 'send':
        if (typeof message.text === 'string' && message.text.trim().length > 0) {
          this.handlers.send(message.text)
        }
        return
      case 'cancel':
        this.handlers.cancel()
        return
      case 'restart':
        this.handlers.restart()
        return
      case 'stop':
        this.handlers.stop()
        return
      case 'newChat':
        this.handlers.newChat()
        return
      case 'openLink':
        this.openLink(message.url ?? '')
        return
      case 'copy':
        if (typeof message.text === 'string') {
          void vscode.env.clipboard.writeText(message.text)
        }
        return
    }
  }

  private openLink(url: string): void {
    if (!/^https?:\/\//i.test(url)) return
    void vscode.env.openExternal(vscode.Uri.parse(url))
  }

  // ---- extension → webview ----

  public setStatus(status: PanelStatus): void {
    void this.panel.webview.postMessage({ type: 'status', status })
  }

  public appendUserMessage(text: string): void {
    void this.panel.webview.postMessage({ type: 'user', text })
  }

  public assistantStart(): void {
    void this.panel.webview.postMessage({ type: 'assistantStart' })
  }

  public appendAssistantChunk(text: string): void {
    void this.panel.webview.postMessage({ type: 'assistantChunk', text })
  }

  public assistantEnd(stopReason: string): void {
    void this.panel.webview.postMessage({ type: 'assistantEnd', stopReason })
  }

  public log(line: string): void {
    void this.panel.webview.postMessage({ type: 'log', text: line })
  }

  public system(text: string): void {
    void this.panel.webview.postMessage({ type: 'system', text })
  }

  public clearView(): void {
    void this.panel.webview.postMessage({ type: 'clear' })
  }

  public error(message: string): void {
    void this.panel.webview.postMessage({ type: 'error', text: message })
  }

  private getHtml(): string {
    const nonce = getNonce()
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Harness</title>
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #d4d4d4);
    --border: var(--vscode-panel-border, #3c3c3c);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --muted: var(--vscode-descriptionForeground, #808080);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--vscode-font-family, -apple-system, Segoe UI, sans-serif);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .title { font-weight: 600; }
  .status {
    display: inline-block;
    margin-left: 8px;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--muted);
    color: var(--bg);
  }
  .status.ready { background: #4ec9b0; }
  .status.busy { background: #dcdcaa; color: #1e1e1e; }
  .status.error { background: #f14c4c; color: #fff; }
  .actions button, .sendrow button {
    background: var(--accent);
    color: var(--accent-fg);
    border: none;
    border-radius: 3px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
  }
  .actions button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  .msg { margin-bottom: 12px; max-width: 92%; word-wrap: break-word; }
  .msg .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
  .msg .role { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .msg .head .copy { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 0 4px; }
  .msg .head .copy:hover { color: var(--fg); text-decoration: underline; }
  .msg .body { padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
  .msg.user .body { background: var(--input-bg); white-space: pre-wrap; }
  .msg.assistant .body { background: rgba(255,255,255,0.04); border: 1px solid var(--border); }
  .msg .stop { display: block; font-size: 10px; color: var(--muted); margin-top: 4px; }
  .msg .body p { margin: 0 0 8px; }
  .msg .body p:last-child { margin-bottom: 0; }
  .msg .body h1, .msg .body h2, .msg .body h3, .msg .body h4, .msg .body h5, .msg .body h6 { margin: 12px 0 6px; font-weight: 600; line-height: 1.25; }
  .msg .body h1 { font-size: 1.4em; }
  .msg .body h2 { font-size: 1.25em; }
  .msg .body h3 { font-size: 1.1em; }
  .msg .body code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; background: rgba(128,128,128,0.2); padding: 1px 4px; border-radius: 3px; }
  .msg .body pre { background: rgba(0,0,0,0.25); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; overflow-x: auto; margin: 8px 0; }
  .msg .body pre code { background: none; padding: 0; font-size: 12px; }
  .msg .body ul, .msg .body ol { margin: 0 0 8px; padding-left: 20px; }
  .msg .body blockquote { border-left: 3px solid var(--border); margin: 8px 0; padding: 2px 10px; color: var(--muted); }
  .msg .body a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
  .msg .body a:hover { text-decoration: underline; }
  .msg.system { color: var(--muted); font-style: italic; }
  .msg.error .body { border: 1px solid #f14c4c; color: #f14c4c; }
  details {
    border-top: 1px solid var(--border);
    padding: 6px 12px;
  }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  details pre {
    max-height: 160px;
    overflow-y: auto;
    margin: 6px 0 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--muted);
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  footer { padding: 8px 12px 12px; border-top: 1px solid var(--border); }
  textarea {
    width: 100%;
    resize: vertical;
    min-height: 52px;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px;
    font-family: inherit;
    font-size: 13px;
  }
  .sendrow { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .hidden { display: none !important; }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--muted);
    border-top-color: var(--fg);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <header>
    <div class="title">DeepSeek Harness <span id="status" class="status">idle</span></div>
    <div class="actions">
      <button id="clear" class="secondary" title="Clear the conversation view">Clear</button>
      <button id="newchat" class="secondary" title="Start a fresh agent session">New Chat</button>
      <button id="restart" class="secondary" title="Restart the agent">Restart</button>
      <button id="stop" class="secondary" title="Stop the agent">Stop</button>
    </div>
  </header>
  <main id="messages"></main>
  <details id="logdetails">
    <summary>Server log</summary>
    <pre id="log"></pre>
  </details>
  <footer>
    <textarea id="input" rows="3" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)"></textarea>
    <div class="sendrow">
      <button id="cancel" class="secondary hidden" title="Cancel the current turn">Cancel</button>
      <button id="send">Send</button>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi()
    const messages = document.getElementById('messages')
    const statusEl = document.getElementById('status')
    const input = document.getElementById('input')
    const sendBtn = document.getElementById('send')
    const cancelBtn = document.getElementById('cancel')
    const logEl = document.getElementById('log')

    let activeAssistant = null

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    }

    function safeUrl(url) {
      return /^(https?:|#|\/|\.)/.test(url)
    }

    function renderInline(s) {
      // s is already HTML-escaped; apply inline formatting without re-escaping.
      s = s.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
        if (safeUrl(url)) return '<a href="' + url + '">' + text + '</a>'
        return m
      })
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
      return s
    }

    function renderMarkdown(src) {
      const lines = String(src).split(/\r?\n/)
      let html = ''
      let i = 0
      let inCode = false
      let codeBuf = []
      let codeLang = ''
      let listType = null

      while (i < lines.length) {
        const line = lines[i]
        const fence = line.match(/^\s*(\x60{3,}|~~~+)/)
        if (fence) {
          if (!inCode) {
            inCode = true
            codeLang = line.trim().slice(3).trim()
            codeBuf = []
          } else {
            html += '<pre><code' + (codeLang ? ' class="language-' + escapeHtml(codeLang) + '"' : '') + '>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'
            inCode = false
            codeBuf = []
            codeLang = ''
          }
          i++
          continue
        }
        if (inCode) { codeBuf.push(line); i++; continue }

        const t = line.trim()
        if (/^#{1,6}\s/.test(t)) {
          const m = t.match(/^(#{1,6})\s+(.*)$/)
          const level = m[1].length
          html += '<h' + level + '>' + renderInline(escapeHtml(m[2])) + '</h' + level + '>'
          listType = null
          i++
          continue
        }
        if (/^[-*+]\s+/.test(t)) {
          if (listType !== 'ul') { if (listType) html += '</' + listType + '>'; html += '<ul>'; listType = 'ul' }
          html += '<li>' + renderInline(escapeHtml(t.replace(/^[-*+]\s+/, ''))) + '</li>'
          i++
          continue
        }
        if (/^\d+\.\s+/.test(t)) {
          if (listType !== 'ol') { if (listType) html += '</' + listType + '>'; html += '<ol>'; listType = 'ol' }
          html += '<li>' + renderInline(escapeHtml(t.replace(/^\d+\.\s+/, ''))) + '</li>'
          i++
          continue
        }
        if (listType) { html += '</' + listType + '>'; listType = null }
        if (t === '') { i++; continue }
        if (/^>\s?/.test(t)) {
          html += '<blockquote>' + renderInline(escapeHtml(t.replace(/^>\s?/, ''))) + '</blockquote>'
          i++
          continue
        }
        const para = []
        while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|\x60|~~~|[-*+]\s|\d+\.\s|>\s?)/.test(lines[i].trim())) {
          para.push(lines[i].trim())
          i++
        }
        html += '<p>' + renderInline(escapeHtml(para.join(' '))) + '</p>'
      }
      if (inCode) html += '<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'
      if (listType) html += '</' + listType + '>'
      return html
    }

    function appendRole(role) {
      const el = document.createElement('div')
      el.className = 'msg ' + role
      const head = document.createElement('div')
      head.className = 'head'
      const roleEl = document.createElement('span')
      roleEl.className = 'role'
      roleEl.textContent = role === 'user' ? 'You' : 'Assistant'
      const copyBtn = document.createElement('button')
      copyBtn.className = 'copy'
      copyBtn.title = 'Copy message'
      copyBtn.textContent = 'Copy'
      copyBtn.addEventListener('click', function () {
        const bodyEl = el.querySelector('.body')
        const text = (bodyEl && bodyEl.rawText) || (bodyEl && bodyEl.textContent) || ''
        vscode.postMessage({ type: 'copy', text: text })
      })
      head.appendChild(roleEl)
      head.appendChild(copyBtn)
      const body = document.createElement('div')
      body.className = 'body'
      body.rawText = ''
      el.appendChild(head)
      el.appendChild(body)
      messages.appendChild(el)
      return body
    }

    function scrollToBottom() {
      messages.scrollTop = messages.scrollHeight
    }

    function setStatus(status) {
      statusEl.textContent = status
      statusEl.className = 'status ' + status
      const busy = status === 'busy' || status === 'starting'
      cancelBtn.classList.toggle('hidden', !busy)
      sendBtn.disabled = busy
      scrollToBottom()
    }

    window.addEventListener('message', (event) => {
      const msg = event.data
      switch (msg.type) {
        case 'status':
          setStatus(msg.status)
          break
        case 'user': {
          const body = appendRole('user')
          body.rawText = msg.text
          body.textContent = msg.text
          scrollToBottom()
          break
        }
        case 'assistantStart':
          activeAssistant = appendRole('assistant')
          activeAssistant.rawText = ''
          scrollToBottom()
          break
        case 'assistantChunk':
          if (!activeAssistant) { activeAssistant = appendRole('assistant'); activeAssistant.rawText = '' }
          activeAssistant.rawText = (activeAssistant.rawText || '') + msg.text
          activeAssistant.innerHTML = renderMarkdown(activeAssistant.rawText)
          scrollToBottom()
          break
        case 'assistantEnd': {
          if (activeAssistant) {
            activeAssistant.innerHTML = renderMarkdown(activeAssistant.rawText || '')
            const stop = document.createElement('span')
            stop.className = 'stop'
            stop.textContent = '— ' + (msg.stopReason || 'done')
            activeAssistant.appendChild(stop)
          }
          activeAssistant = null
          scrollToBottom()
          break
        }
        case 'log': {
          logEl.textContent += msg.text + '\\n'
          break
        }
        case 'clear':
          clearView()
          break
        case 'system': {
          const el = document.createElement('div')
          el.className = 'msg system'
          el.textContent = msg.text
          messages.appendChild(el)
          scrollToBottom()
          break
        }
        case 'error': {
          const el = document.createElement('div')
          el.className = 'msg error'
          const body = document.createElement('div')
          body.className = 'body'
          body.textContent = 'Error: ' + msg.text
          el.appendChild(body)
          messages.appendChild(el)
          activeAssistant = null
          const logdetails = document.getElementById('logdetails')
          if (logdetails) logdetails.open = true
          scrollToBottom()
          break
        }
      }
    })

    function send() {
      const text = input.value.trim()
      if (!text) return
      input.value = ''
      vscode.postMessage({ type: 'send', text })
    }

    sendBtn.addEventListener('click', send)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        send()
      }
    })
    cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }))
    function clearView() {
      messages.innerHTML = ''
      activeAssistant = null
    }
    document.getElementById('clear').addEventListener('click', clearView)
    document.getElementById('newchat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }))
    document.getElementById('restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }))
    document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null
      if (a && a.getAttribute('href')) {
        e.preventDefault()
        vscode.postMessage({ type: 'openLink', url: a.getAttribute('href') })
      }
    })
  </script>
</body>
</html>`
  }
}
