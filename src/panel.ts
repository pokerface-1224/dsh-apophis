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

  private handleMessage(message: { type: string; text?: string }): void {
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
    }
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
  .msg { margin-bottom: 12px; max-width: 92%; white-space: pre-wrap; word-wrap: break-word; }
  .msg .role { font-size: 11px; color: var(--muted); margin-bottom: 2px; text-transform: uppercase; letter-spacing: 0.04em; }
  .msg .body { padding: 8px 10px; border-radius: 6px; }
  .msg.user .body { background: var(--input-bg); }
  .msg.assistant .body { background: rgba(255,255,255,0.04); border: 1px solid var(--border); }
  .msg .stop { display: block; font-size: 10px; color: var(--muted); margin-top: 4px; }
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
      <button id="restart" class="secondary" title="Restart the agent">Restart</button>
      <button id="stop" class="secondary" title="Stop the agent">Stop</button>
    </div>
  </header>
  <main id="messages"></main>
  <details>
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

    function appendRole(role) {
      const el = document.createElement('div')
      el.className = 'msg ' + role
      const roleEl = document.createElement('div')
      roleEl.className = 'role'
      roleEl.textContent = role === 'user' ? 'You' : 'Assistant'
      const body = document.createElement('div')
      body.className = 'body'
      el.appendChild(roleEl)
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
          body.textContent = msg.text
          scrollToBottom()
          break
        }
        case 'assistantStart':
          activeAssistant = appendRole('assistant')
          scrollToBottom()
          break
        case 'assistantChunk':
          if (!activeAssistant) activeAssistant = appendRole('assistant')
          activeAssistant.textContent += msg.text
          scrollToBottom()
          break
        case 'assistantEnd': {
          if (activeAssistant) {
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
    document.getElementById('restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }))
    document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
  </script>
</body>
</html>`
  }
}
