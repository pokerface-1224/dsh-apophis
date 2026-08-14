/**
 * ACP client session for the dsh VS Code extension.
 *
 * Spawns a DeepSeek Harness ACP server (`@deepseek-ai/dsh-acp-demo`) over
 * JSON-RPC stdio and drives one agent session through
 * `@agentclientprotocol/sdk`. The shape mirrors the reference ACP client in
 * deepseek-harness's `packages/subagent/subagent-acp/src/run.ts`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'

export type SessionStatus = 'idle' | 'starting' | 'ready' | 'busy' | 'stopped' | 'error'

export type PermissionChoice = 'allow-once' | 'reject-once' | 'cancelled'

export interface PermissionRequestInfo {
  sessionId: string
  toolCallId: string
  title: string
  options: { optionId: string; name: string; kind: string }[]
}

export interface AcpSessionConfig {
  /** Executable to spawn (the ACP server). */
  command: string
  /** Arguments for the executable. */
  args: string[]
  /** Process working directory for the server. */
  cwd: string
  /** Absolute workspace directory passed to `session/new`. */
  sessionCwd: string
  /** Extra environment variables for the server (e.g. DEEPSEEK_API_KEY). */
  env: Record<string, string>
  /** Launch through a shell (for .cmd/.bat launchers). */
  useShell: boolean
  /** Permission policy: ask the user, auto-allow once, or auto-reject. */
  permission: 'ask' | 'allow' | 'reject'
  /** Only used when `permission` is `ask`. */
  askPermission?: (req: PermissionRequestInfo) => Promise<PermissionChoice>
}

export interface AcpSessionCallbacks {
  onStatus(status: SessionStatus): void
  onAssistantChunk(text: string): void
  onPromptEnded(stopReason: StopReason): void
  onLog(line: string): void
  onError(message: string): void
}

export class AcpSession {
  private proc?: ChildProcessWithoutNullStreams
  private conn?: ClientSideConnection
  private sessionId?: string
  private status: SessionStatus = 'idle'
  private disposed = false

  constructor(
    private readonly config: AcpSessionConfig,
    private readonly cb: AcpSessionCallbacks,
  ) {}

  get currentStatus(): SessionStatus {
    return this.status
  }

  private setStatus(status: SessionStatus): void {
    this.status = status
    this.cb.onStatus(status)
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error('session already started')
    this.setStatus('starting')

    const proc = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.config.useShell,
      windowsHide: true,
    })
    this.proc = proc

    proc.on('error', (err: Error) => {
      this.cb.onError(`failed to launch ACP server: ${err.message}`)
      this.setStatus('error')
    })

    proc.on('exit', (code, signal) => {
      if (this.disposed) return
      this.cb.onLog(`server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      this.setStatus('stopped')
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.cb.onLog(line)
      }
    })

    const client: Client = {
      sessionUpdate: (params: SessionNotification) => this.handleSessionUpdate(params),
      requestPermission: (params: RequestPermissionRequest) => this.handlePermission(params),
    }

    this.conn = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
      ),
    )

    try {
      await this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await this.conn.newSession({ cwd: this.config.sessionCwd, mcpServers: [] })
      this.sessionId = sessionId
      this.setStatus('ready')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.cb.onError(`session initialization failed: ${message}`)
      this.setStatus('error')
      throw err
    }
  }

  private handleSessionUpdate(params: SessionNotification): Promise<void> {
    // Ignore updates from orphaned sessions (e.g. after a new session replaced
    // the active one on the same connection).
    if (this.sessionId !== undefined && params.sessionId !== this.sessionId) {
      return Promise.resolve()
    }
    const update = params.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content
      if (content.type === 'text' && content.text.length > 0) {
        this.cb.onAssistantChunk(content.text)
      }
    }
    // Other updates (thoughts, tool calls, plans, usage) are intentionally
    // not surfaced: the ACP bridge emits only committed assistant text.
    return Promise.resolve()
  }

  private async handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const info: PermissionRequestInfo = {
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? '',
      options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    }

    let choice: PermissionChoice
    if (this.config.permission === 'allow') {
      choice = 'allow-once'
    } else if (this.config.permission === 'reject') {
      choice = 'reject-once'
    } else {
      choice = this.config.askPermission ? await this.config.askPermission(info) : 'cancelled'
    }

    return this.resolveChoice(params, choice)
  }

  private resolveChoice(params: RequestPermissionRequest, choice: PermissionChoice): RequestPermissionResponse {
    if (choice === 'allow-once') {
      const option =
        params.options.find((o) => o.optionId === 'allow-once') ??
        params.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
    if (choice === 'reject-once') {
      const option =
        params.options.find((o) => o.optionId === 'reject-once') ??
        params.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')
      if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }

  async sendPrompt(text: string): Promise<StopReason> {
    if (!this.conn || !this.sessionId) throw new Error('session is not ready')
    this.setStatus('busy')
    try {
      const result = await this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text }] })
      this.cb.onPromptEnded(result.stopReason)
      return result.stopReason
    } finally {
      if (!this.disposed) this.setStatus('ready')
    }
  }

  async newSession(): Promise<void> {
    if (!this.conn) throw new Error('session is not connected')
    if (this.status === 'busy' || this.status === 'starting') {
      throw new Error('cannot start a new session while the agent is busy')
    }
    const { sessionId } = await this.conn.newSession({ cwd: this.config.sessionCwd, mcpServers: [] })
    this.sessionId = sessionId
  }

  async cancel(): Promise<void> {
    if (this.conn && this.sessionId) {
      await this.conn.cancel({ sessionId: this.sessionId }).catch(() => {})
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.conn && this.sessionId) {
      await this.conn.cancel({ sessionId: this.sessionId }).catch(() => {})
    }
    const proc = this.proc
    if (proc) {
      // Closing stdin lets the server quiesce and flush persistence.
      try {
        proc.stdin.end()
      } catch {
        /* already closed */
      }
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(() => {
          try {
            proc.kill()
          } catch {
            /* already gone */
          }
        }, 3000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.setStatus('stopped')
  }
}
