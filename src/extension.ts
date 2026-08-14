/**
 * DeepSeek Harness VS Code extension entry point.
 *
 * Wires a chat webview to a single ACP agent session: the extension owns the
 * `AcpSession` (spawned child process + ACP client) and the `ChatPanel` renders
 * the conversation and forwards user actions.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { AcpSession, type AcpSessionConfig, type PermissionChoice, type PermissionRequestInfo } from './acpSession.js'
import { ChatPanel } from './panel.js'

let session: AcpSession | undefined
let panel: ChatPanel | undefined

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.startChat', () => void startChat(context)),
    vscode.commands.registerCommand('dsh.openChat', () => void openChat(context)),
    vscode.commands.registerCommand('dsh.newChat', () => void newChat()),
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
  const model = config.get<string>('model') ?? 'deepseek-v4-pro'
  const provider = config.get<string>('provider') ?? 'deepseek-official'
  const models = config.get<string[]>('models') ?? ['deepseek-v4-pro', 'deepseek-v4-flash']
  const serverEnv: Record<string, string> = { ...env, DSH_MODEL: model, DSH_PROVIDER: provider }

  const configuredArgs = config.get<string[]>('server.args') ?? []
  let args = configuredArgs
  const usesDefaultArgs = args.length === 0
  if (usesDefaultArgs) {
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
    newChat: () => void newChat(),
    setModel: (m) => void setModel(context, m),
  })

  panel.setModels(models, model)

  const { errors, warnings } = validateStartup({ command, args, repoPath, serverCwd, usesDefaultArgs, env })
  for (const warning of warnings) panel.system(`Warning: ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) panel.error(error)
    void vscode.window.showErrorMessage(`DeepSeek Harness: ${errors[0]}`)
    return
  }

  panel.system(`Launching ACP server: ${command} ${args.join(' ')}`)
  panel.system(`Server working directory: ${serverCwd}`)
  panel.system(`Agent workspace (session cwd): ${sessionCwd}`)

  if (session) await session.dispose()

  const cfg: AcpSessionConfig = {
    command,
    args,
    cwd: serverCwd,
    sessionCwd,
    env: serverEnv,
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

async function openChat(context: vscode.ExtensionContext): Promise<void> {
  const s = session
  if (s && (s.currentStatus === 'ready' || s.currentStatus === 'busy' || s.currentStatus === 'starting')) {
    panel?.reveal()
    return
  }
  await startChat(context)
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

async function newChat(): Promise<void> {
  const s = session
  if (!s) {
    panel?.error('No active agent session.')
    return
  }
  try {
    await s.newSession()
    panel?.clearView()
    panel?.system('Started a new agent session (same server connection).')
  } catch (err: unknown) {
    panel?.error(err instanceof Error ? err.message : String(err))
  }
}

async function setModel(context: vscode.ExtensionContext, model: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('dsh')
  await config.update('model', model, vscode.ConfigurationTarget.Global)
  panel?.system(`Switching model to ${model}…`)
  await restart(context)
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

interface StartupValidation {
  errors: string[]
  warnings: string[]
}

function validateStartup(opts: {
  command: string
  args: string[]
  repoPath: string
  serverCwd: string
  usesDefaultArgs: boolean
  env: Record<string, string>
}): StartupValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!opts.command.trim()) {
    errors.push('`dsh.server.command` is empty.')
  }

  if (opts.usesDefaultArgs) {
    if (!opts.repoPath) {
      errors.push('`dsh.server.repoPath` is empty and `dsh.server.args` is not set — cannot build the launch command.')
    } else if (!existsSync(opts.repoPath)) {
      errors.push(`\`dsh.server.repoPath\` does not exist: ${opts.repoPath}`)
    } else {
      const bin = join(opts.repoPath, 'packages', 'examples', 'acp-demo', 'src', 'bin.ts')
      const cfgPath = join(opts.repoPath, 'examples', 'acp-agent', 'cordis.yml')
      if (!existsSync(bin)) errors.push(`ACP server entry not found: ${bin}`)
      if (!existsSync(cfgPath)) errors.push(`ACP config not found: ${cfgPath}`)
    }
  }

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  if (nodeMajor < 22) {
    warnings.push(`the harness requires Node 22.19+; the current runtime reports Node ${process.versions.node}.`)
  }

  if (!opts.env['DEEPSEEK_API_KEY'] && !process.env['DEEPSEEK_API_KEY']) {
    warnings.push('no DEEPSEEK_API_KEY found in `dsh.server.env` or the environment; model calls will fail unless the server loads it from a repo-root .env.')
  }

  return { errors, warnings }
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
