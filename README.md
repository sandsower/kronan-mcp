# kronan-mcp

MCP server for the [Krónan](https://kronan.is) grocery store API. Claude can browse products, manage shopping notes, handle checkout, and track orders from Krónan's Snjallverslun (smart store) in Iceland.

## Tools

25 tools over the Model Context Protocol:

| Category | Tools |
|----------|-------|
| Products | `search_products`, `get_product`, `get_category_products`, `list_categories` |
| Checkout | `get_checkout`, `add_checkout_lines` |
| Orders | `list_orders`, `get_order`, `delete_order_lines`, `set_order_substitution`, `lower_order_quantity` |
| Shopping notes | `get_shopping_note`, `add_shopping_note_line`, `change_shopping_note_line`, `reorder_shopping_note_lines`, `delete_shopping_note_line`, `set_line_completion`, `clear_shopping_note`, `check_store_order_eligibility`, `apply_store_product_order`, `list_archived_lines`, `delete_archived_line` |
| Product lists | `list_product_lists`, `create_product_list`, `get_product_list`, `update_product_list`, `delete_product_list`, `clear_product_list`, `sort_product_list`, `update_product_list_item` |
| Purchase stats | `list_purchase_stats`, `set_purchase_stat_ignored` |
| Account | `get_me` |

## Install

```bash
npm install -g kronan-mcp
```

Or run directly with npx (no install needed):

```bash
npx kronan-mcp
```

### Getting a token

Tokens are created in the Krónan Snjallverslun user settings. You need an account with Audkenni (Iceland's electronic ID) login. Go to your user or customer group settings page and create an access token. Tokens are prefixed with `act_`.

## Usage with Claude Code

Add to your project's `.claude/settings.local.json` or global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "kronan": {
      "command": "npx",
      "args": ["kronan-mcp"],
      "env": {
        "KRONAN_ACCESS_TOKEN": "act_your_token_here"
      }
    }
  }
}
```

Then ask Claude things like:

- "Search for milk on Krónan"
- "What's in my shopping note?"
- "Add 2x of SKU 02500188 to my checkout"
- "Show my recent orders"

## Architecture

```
src/
├── client.ts   HTTP client wrapping all Krónan API endpoints
├── index.ts    MCP server registering tools via @modelcontextprotocol/sdk
└── types.ts    TypeScript interfaces matching the OpenAPI schema
```

Auth is `Authorization: AccessToken <token>` on every request. Rate limit is 200 requests per 200 seconds per user. The client detects 429 responses and tells the caller to wait.

All prices are integers in ISK (no decimals). 230 means 230 kr.

Errors go through a typed `KronanApiError` with status codes. The token is scrubbed from error messages so it doesn't leak to the LLM. Auth failures and rate limits get their own user-facing messages.

`set_order_substitution` and `set_line_completion` use read-then-toggle patterns. They're not idempotent. Don't retry on timeout without checking current state first.

## API reference

Full OpenAPI schema at `openapi-schema.yaml`.

## Development

```bash
npm install && npm run build   # Build from source
npm run dev                    # Watch mode (recompiles on change)
npm test                       # Run tests
npm run test:watch             # Watch mode tests
```

## Tests

31 tests on the HTTP client: constructor validation, error paths (429, timeouts, JSON parse failures), token scrubbing, toggle method validation, eligibility endpoint edge cases.

```bash
npm test
```
