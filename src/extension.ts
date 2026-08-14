/**
 * DeepSeek Harness VS Code extension entry point.
 *
 * Wires a chat webview to a single ACP agent session: the extension owns the
 * `AcpSession` (spawned child process + ACP client) and the `ChatPanel` renders
 * the conversation and forwards user actions.
 */

import { dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { AcpSession, type AcpSessionConfig, type PermissionChoice, type PermissionRequestInfo } from './acpSession.js'
import { ChatPanel } from './panel.js'

let session: AcpSession | undefined
let panel: ChatPanel | undefined

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.startChat', () => void startChat(context)),
    vscode.commands.registerCommand('dsh.restartChat', () => void restart(context)),
    vscode.commands.registerCommand('dsh.stopChat', () => void stop()),
  )
}

export function deactivate(): Thenable<void> {
  return stop()
}

async function startChat(context: vscode.ExtensionContext): Promise<void> {
  const sessionCwd = resolveWorkspaceCwd()
  if (!sessionCwd) {
    void vscode.window.showErrorMessage('DeepSeek Harness: open a workspace folder to give the agent a working directory.')
    return
  }

  const config = vscode.workspace.getConfiguration('dsh')
  const repoPath = config.get<string>('server.repoPath') ?? ''
  const command = config.get<string>('server.command') ?? 'node'
  const useShell = config.get<boolean>('server.useShell') ?? false
  const env = config.get<Record<string, string>>('server.env') ?? {}
  const permission = (config.get<string>('permission') ?? 'ask') as AcpSessionConfig['permission']

  let args = config.get<string[]>('server.args') ?? []
  if (args.length === 0) {
    if (!repoPath) {
      void vscode.window.showErrorMessage('DeepSeek Harness: set `dsh.server.args` or `dsh.server.repoPath` to launch the ACP server.')
      return
    }
    args = [
      '--import',
      'tsx/esm',
      join(repoPath, 'packages', 'examples', 'acp-demo', 'src', 'bin.ts'),
      '--config',
      join(repoPath, 'examples', 'acp-agent', 'cordis.yml'),
    ]
  }
  const serverCwd = config.get<string>('server.cwd') || repoPath || sessionCwd

  panel = ChatPanel.createOrShow(context, {
    send: (text) => void sendPrompt(text),
    cancel: () => void session?.cancel(),
    restart: () => void restart(context),
    stop: () => void stop(),
  })

  panel.system(`Launching ACP server: ${command} ${args.join(' ')}`)
  panel.system(`Server working directory: ${serverCwd}`)
  panel.system(`Agent workspace (session cwd): ${sessionCwd}`)

  if (session) await session.dispose()

  const cfg: AcpSessionConfig = {
    command,
    args,
    cwd: serverCwd,
    sessionCwd,
    env,
    useShell,
    permission,
    askPermission: (req) => askPermission(req),
  }
  const s = new AcpSession(cfg, {
    onStatus: (status) => panel?.setStatus(status),
    onAssistantChunk: (text) => panel?.appendAssistantChunk(text),
    onPromptEnded: (stopReason) => panel?.assistantEnd(stopReason),
    onLog: (line) => panel?.log(line),
    onError: (message) => panel?.error(message),
  })
  session = s
  try {
    await s.start()
  } catch {
    // The failure is already surfaced through onError.
  }
}

async function sendPrompt(text: string): Promise<void> {
  const s = session
  if (!s || s.currentStatus !== 'ready') {
    panel?.error('The agent is not ready yet. Wait for it to start, then try again.')
    return
  }
  panel?.appendUserMessage(text)
  panel?.assistantStart()
  try {
    await s.sendPrompt(text)
  } catch (err: unknown) {
    panel?.error(err instanceof Error ? err.message : String(err))
  }
}

async function restart(context: vscode.ExtensionContext): Promise<void> {
  await stop()
  await startChat(context)
}

async function stop(): Promise<void> {
  const s = session
  session = undefined
  if (s) await s.dispose()
}

function resolveWorkspaceCwd(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (folder) return folder.uri.fsPath
  const editor = vscode.window.activeTextEditor
  if (editor && !editor.document.isUntitled) return dirname(editor.document.uri.fsPath)
  return process.env.USERPROFILE || process.env.HOME || undefined
}

async function askPermission(req: PermissionRequestInfo): Promise<PermissionChoice> {
  const labels = req.options.map((o) => o.name)
  const placeHolder = req.title
    ? `Permission request: ${req.title}`
    : `The agent requests permission (tool call ${req.toolCallId})`
  const picked = await vscode.window.showQuickPick(labels, { placeHolder, ignoreFocusOut: true })
  if (picked === undefined) return 'cancelled'
  const index = labels.indexOf(picked)
  const option = req.options[index]
  if (!option) return 'cancelled'
  if (option.kind === 'allow_once' || option.kind === 'allow_always' || option.optionId === 'allow-once') {
    return 'allow-once'
  }
  if (option.kind === 'reject_once' || option.kind === 'reject_always' || option.optionId === 'reject-once') {
    return 'reject-once'
  }
  return 'cancelled'
}
