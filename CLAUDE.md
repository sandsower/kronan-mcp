# kronan-mcp

MCP server for the Krónan grocery store API (Iceland).

## Build

```
npm install && npm run build
```

## Configure

Requires `KRONAN_ACCESS_TOKEN` environment variable. Tokens are created via Audkenni login in the Krónan user/customer group settings.

## Usage in Claude Code

Add to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "kronan": {
      "command": "node",
      "args": ["/path/to/kronan-mcp/dist/index.js"],
      "env": {
        "KRONAN_ACCESS_TOKEN": "<your-token>"
      }
    }
  }
}
```

## API reference

The OpenAPI schema is saved at `openapi-schema.yaml` for reference.

## Architecture

- `src/client.ts` — HTTP client wrapping all Krónan API endpoints
- `src/index.ts` — MCP server registering tools via `@modelcontextprotocol/sdk`
- Auth: `Authorization: AccessToken <token>` header
- Rate limit: 200 requests / 200 seconds per user
- Monetary values are integers (ISK, no decimals)
