# DeepSeek Harness for VS Code

Chat with a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent
inside VS Code, driven over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP).

> **Status:** minimal runnable skeleton (MVP). It spawns the harness's ACP server
> (`@deepseek-ai/dsh-acp-demo`), creates one agent session per VS Code workspace, streams
> the agent's committed replies into a chat panel, and surfaces sandbox permission
> requests. Markdown rendering, session history/resume, tool-call cards, and plans are
> intentionally out of scope for now.

## How it works

```
VS Code extension (ACP client)
        │  JSON-RPC over stdio
        ▼
dsh-acp-demo (ACP server)  ──►  DeepSeek model  ──►  sandboxed bash + filesystem tools
```

The extension:

1. Spawns the harness ACP server as a child process.
2. Calls `initialize`, then `session/new` with the current workspace folder as `cwd`.
3. Sends your prompt via `session/prompt`, streams `agent_message_chunk` updates into the
   panel, and answers `session/request_permission` requests.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`
- A `deepseek-harness` checkout (with dependencies installed: `pnpm install`)
- A `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`)

## Install & build

```sh
cd dsh-apophis
npm install
npm run build
```

Then open the folder in VS Code and press **F5** to launch an Extension Development Host,
or package it with `npx @vscode/vsce package`.

This extension is an **ESM extension** (`"type": "module"`): `npm run build` compiles `src/`
with `tsc` into `dist/`, and the ACP SDK + `zod` ship as normal `dependencies` (no bundler).

### Smoke test (no API key, no model call)

Verify the ACP wiring against the real dsh server with a handshake-only test
(`initialize` + `session/new`, then dispose):

```sh
node scripts/smoke.mjs
```

Expected output ends with `HANDSHAKE OK — status: ready`. Edit `repoPath`/`sessionCwd` at
the top of the script if your checkout lives elsewhere.

## Configure

Open **Settings → Extensions → DeepSeek Harness**, or set these in `settings.json`:

```jsonc
{
  // Path to the deepseek-harness checkout. Used to build the default launch
  // command and as the server's working directory.
  "dsh.server.repoPath": "D:\\deepseek-harness",

  // API credentials handed to the spawned server.
  "dsh.server.env": {
    "DEEPSEEK_API_KEY": "sk-...",
    "DEEPSEEK_BASE_URL": "https://..."   // optional
  },

  // How to answer the agent's sandbox permission requests.
  "dsh.permission": "ask"   // "ask" | "allow" | "reject"
}
```

By default the extension launches the server with:

```
node --import tsx/esm <repoPath>/packages/examples/acp-demo/src/bin.ts \
     --config <repoPath>/examples/acp-agent/cordis.yml
```

To use a different launcher (for example a built/npm-installed server), override
`dsh.server.command` and `dsh.server.args` explicitly:

```jsonc
{
  "dsh.server.command": "dsh-acp-demo",
  "dsh.server.args": ["--config", "/path/to/cordis.yml"],
  "dsh.server.cwd": "/path/to/server/working/dir"
}
```

Use `dsh.server.useShell: true` when the command is a `.cmd`/`.bat` (e.g. `pnpm.cmd`).

## Commands

- **DeepSeek Harness: Start Chat** — open the chat panel and start the agent.
- **DeepSeek Harness: Restart Agent** — stop and relaunch the agent.
- **DeepSeek Harness: Stop Agent** — cancel the current turn and stop the server.

## Notes

- The server persists sessions under `./.sessions` relative to its working directory
  (`dsh.server.cwd`, which defaults to `dsh.server.repoPath`). The `session/new` workspace
  is your VS Code workspace folder, so the agent's sandboxed reads/writes target that folder.
- ACP surfaces only *committed* assistant text; reasoning, tool activity, and plans stay in
  the server-side session log.
- This project is a skeleton: it is not published on the VS Code Marketplace and is not an
  official DeepSeek product.
