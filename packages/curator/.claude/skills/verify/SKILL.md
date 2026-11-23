---
name: verify
description: Launch the real curator MCP server against a temp DB and drive its tools over Streamable HTTP, without touching prod or spending LLM tokens.
---

# Verifying vault-curator at the MCP HTTP surface

Prod runs on port 3335 from `/path/to/vault-suite` — never bind 3335 or point at the prod DB.

1. **Mint tokens into a fresh temp DB** (creates the auth schema as a side effect):
   ```bash
   CURATOR_DB_PATH=$TMP/curator.db npx tsx scripts/issue-service-token.ts --name verify --scope curate:trigger,curate:read
   ```
2. **Boot the built server** (build first: `npm run build -w vault-curator`). Required env:
   `CURATOR_DB_PATH`, `CURATOR_PORT=3435`, `ENGINE_URL`, `ENGINE_TOKEN`, `ANTHROPIC_API_KEY`
   (dummy is fine if no synthesis path is exercised), `OAUTH_OWNER_PASSWORD`, and
   `OAUTH_ISSUER_URL` (http allowed only for 127.0.0.1). Boot runs migrations and may fire a
   catch-up sweep immediately — with a dead/stub engine it fails harmlessly and is logged.
3. **Engine stub**: every wiki tool calls `engine.ensureTopicSchema()` first, so `ENGINE_URL`
   must answer MCP. A ~20-line node script with `McpServer` + `StreamableHTTPServerTransport`
   (`sessionIdGenerator: undefined`, one `describe-schema` tool returning
   `{ok:true,data:{...}}`) is enough for all non-curation paths.
4. **Drive it** with `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`
   and an `Authorization: Bearer <token>` header (raw curl needs the initialize dance — use
   the SDK client). Seed `wiki_roots` rows directly via `sqlite3` on the temp DB to simulate
   pre-existing wikis.

Gotcha: driver/stub scripts must live inside the repo tree for bare `@modelcontextprotocol/sdk`
imports to resolve; delete them before committing.
