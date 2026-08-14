/**
 * Handshake-only smoke test for the ACP client session.
 *
 * Boots the real dsh ACP server, performs `initialize` + `session/new`, then
 * disposes — no prompt, no model call, no API key required. Run from the
 * extension folder:
 *
 *   node scripts/smoke.mjs
 */

import { AcpSession } from '../dist/acpSession.js'

const repoPath = 'D:/deepseek-harness'
const sessionCwd = 'D:/deepseek-harness-test'

const session = new AcpSession(
  {
    command: 'node',
    args: [
      '--import',
      'tsx/esm',
      `${repoPath}/packages/examples/acp-demo/src/bin.ts`,
      '--config',
      `${repoPath}/examples/acp-agent/cordis.yml`,
    ],
    cwd: repoPath,
    sessionCwd,
    env: { DSH_SNAPSHOT_SESSIONS_ROOT: `${sessionCwd}/.dsh-smoke-sessions` },
    useShell: false,
    permission: 'reject',
  },
  {
    onStatus: (s) => console.log('[status]', s),
    onAssistantChunk: (t) => console.log('[chunk]', t),
    onPromptEnded: (r) => console.log('[end]', r),
    onLog: (l) => console.log('[log]', l),
    onError: (e) => console.error('[error]', e),
  },
)

try {
  await session.start()
  console.log('HANDSHAKE OK — status:', session.currentStatus)
  process.exitCode = 0
} catch (err) {
  console.error('HANDSHAKE FAILED:', err)
  process.exitCode = 1
} finally {
  await session.dispose()
}
