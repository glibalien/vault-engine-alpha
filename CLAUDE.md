# Claude Code compatibility

Read and follow [`AGENTS.md`](./AGENTS.md) for monorepo-wide instructions. Before changing
`packages/engine` or `packages/curator`, also read that package's `AGENTS.md`; package
guidance is more specific and takes precedence for its subtree.

Where one of those packages has its own `CLAUDE.md`, that file holds the maintainers'
working notes for Claude Code: detailed context, dated decisions and measurements. The
package's `AGENTS.md` says when to read it. Keep cross-agent working rules in `AGENTS.md` so
Claude Code and Codex operate from the same architecture and validation expectations.
