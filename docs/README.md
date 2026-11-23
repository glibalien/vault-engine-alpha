# Vault Engine documentation

Current guidance for people and agents working in this repository.

- [Root README](../README.md) — product overview, quick start, packages, and common commands.
- [Contributor guide](../CONTRIBUTING.md) — fresh-clone setup, validation, safety, and review expectations.
- [Repository safety](repository-safety.md) — what may be committed, how to report a suspected credential, and how to run the safety lint.
- [Root agent guidance](../AGENTS.md) — authoritative monorepo boundaries and working rules.
- Package READMEs and the nearest package `AGENTS.md` — package-specific behavior and commands.
- [How memories work](memories-explained.md) — where memories come from, how the Engine keeps them, and who reads them, with a traced wiki build.
- [Durable memory Markdown projection](memory-markdown-log.md) — current projection ownership and format.
- [Model prompts](model-prompts.md) — every system prompt the suite sends to a model: its job, file, override key, output mode and eval.

## Records that may be absent

Dated design records (`docs/superpowers/`, `docs/foundations/`,
`packages/*/docs/superpowers/`) and the owner's own deployment runbooks are not part of
every copy of this repository. Comments, agent notes, and older text sometimes name a path
inside them. Where such a path does not resolve, the current READMEs, `AGENTS.md` files,
and source are the guidance. Where the records are present, `docs/superpowers/README.md`
indexes them.
