# Contributing to dsh-apophis

Thanks for your interest in contributing!

`dsh-apophis` is a minimal VS Code extension that connects to a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

## Getting started

1. Clone the repository.
2. `npm install`
3. `npm run build` — compiles `src/` with `tsc` into `dist/`.
4. Open the folder in VS Code and press **F5** to launch an Extension Development Host.
5. Optionally run `node scripts/smoke.mjs` for a handshake-only ACP test (no API key).

## Before submitting

- Run `npm run typecheck` and make sure it passes.
- Keep changes focused, and explain *what* and *why* in the pull request.

## Commit style

Use short, imperative commit messages (for example, "Add markdown rendering to the chat panel").

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT license](LICENSE).
