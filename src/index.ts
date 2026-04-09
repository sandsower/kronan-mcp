#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { KronanClient, KronanApiError } from "./client.js";

const server = new McpServer({
  name: "kronan",
  version: "1.0.0",
  description: "MCP server for the Krónan grocery store API (Iceland). Browse products, manage orders, shopping notes, product lists, and checkout.",
});

// ── Singleton client ───────────────────────────────────────────────

let client: KronanClient | undefined;

function getClient(): KronanClient {
  if (!client) {
    const token = process.env.KRONAN_ACCESS_TOKEN;
    if (!token) {
      throw new Error("KRONAN_ACCESS_TOKEN environment variable is required");
    }
    client = new KronanClient(token);
  }
  return client;
}

// ── Helpers ────────────────────────────────────────────────────────

function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function handleTool<T>(fn: () => Promise<T>) {
  try {
    return result(await fn());
  } catch (err: unknown) {
    if (err instanceof KronanApiError) {
      switch (err.status) {
        case 401:
          return errorResult("Authentication failed. Your KRONAN_ACCESS_TOKEN may be invalid or expired. Generate a new one in your Krónan account settings.");
        case 403:
          return errorResult("Access denied. Your token may lack the required permissions for this operation.");
        case 404:
          return errorResult(`Resource not found: ${err.message}`);
        default:
          return errorResult(err.message);
      }
    }

    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("rate limit exceeded")) {
      return errorResult(msg);
    }
    if (msg.includes("timed out")) {
      return errorResult(msg);
    }
    if (msg.includes("non-JSON response")) {
      return errorResult(`Unexpected response from Krónan API: ${msg}`);
    }
    return errorResult(msg);
  }
}

// ── Me ──────────────────────────────────────────────────────────────

server.tool("get_me", "Get the current authenticated identity (user or customer group)", {}, async () => {
  return handleTool(() => getClient().getMe());
});

// ── Categories ──────────────────────────────────────────────────────

server.tool("list_categories", "Get the full 3-level category tree", {}, async () => {
  return handleTool(() => getClient().listCategories());
});

server.tool(
  "get_category_products",
  "Get paginated product listing for a category (48 per page)",
  {
    slug: z.string().regex(/^[-a-zA-Z0-9_]+$/, "Invalid category slug").max(128).describe("Category slug"),
    page: z.number().int().min(1).optional().describe("Page number (default: 1)"),
  },
  async ({ slug, page }) => {
    return handleTool(() => getClient().getCategoryProducts(slug, page));
  }
);

// ── Products ────────────────────────────────────────────────────────

server.tool(
  "get_product",
  "Get full product details including price, discounts, tags, availability",
  {
    sku: z.string().max(40).describe("Product SKU"),
  },
  async ({ sku }) => {
    return handleTool(() => getClient().getProduct(sku));
  }
);

server.tool(
  "search_products",
  "Search for products in the smart store selection. Returns products available for home delivery.",
  {
    query: z.string().max(64).describe("Search query (max 64 chars)"),
    page: z.number().int().min(1).optional().describe("Page number"),
    pageSize: z.number().int().min(1).max(100).optional().describe("Results per page (max 100)"),
    sortBy: z.enum(["price", "name"]).optional().describe("Sort field"),
    withDetail: z.boolean().optional().describe("Include discounted price, discount percent, and tags (slower)"),
  },
  async ({ query, page, pageSize, sortBy, withDetail }) => {
    return handleTool(() => getClient().searchProducts(query, { page, pageSize, sortBy, withDetail }));
  }
);

// ── Checkout ────────────────────────────────────────────────────────

server.tool("get_checkout", "Get the active smart checkout (auto-creates if none exists)", {}, async () => {
  return handleTool(() => getClient().getCheckout());
});

server.tool(
  "add_checkout_lines",
  "Add product lines to the active checkout. Set replace=true to replace all existing lines.",
  {
    lines: z
      .array(
        z.object({
          sku: z.string().max(40).describe("Product SKU"),
          quantity: z.number().int().min(0).max(500).optional().describe("Quantity (default: 1)"),
          substitution: z.boolean().optional().describe("Allow substitution if unavailable"),
        })
      )
      .describe("Lines to add"),
    replace: z.boolean().optional().describe("Replace all existing lines (default: false)"),
  },
  async ({ lines, replace }) => {
    return handleTool(() => getClient().addCheckoutLines(lines, replace));
  }
);

// ── Orders ──────────────────────────────────────────────────────────

server.tool(
  "list_orders",
  "List orders, most recent first",
  {
    limit: z.number().int().min(1).optional().describe("Results per page"),
    offset: z.number().int().min(0).optional().describe("Starting index"),
    type: z
      .enum(["delivery", "pickup", "scan_n_go", "digital", "digital_card_batch", "dropp", "navision"])
      .optional()
      .describe("Filter by order type"),
  },
  async ({ limit, offset, type }) => {
    return handleTool(() => getClient().listOrders({ limit, offset, type }));
  }
);

server.tool(
  "get_order",
  "Get full order details including lines with product thumbnails",
  {
    token: z.string().describe("Order token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().getOrder(token));
  }
);

server.tool(
  "delete_order_lines",
  "Remove specific lines from an order by their IDs. Service lines and the last remaining line cannot be deleted.",
  {
    token: z.string().describe("Order token"),
    lineIds: z.array(z.number().int()).describe("IDs of lines to delete"),
  },
  async ({ token, lineIds }) => {
    return handleTool(() => getClient().deleteOrderLines(token, lineIds));
  }
);

server.tool(
  "set_order_substitution",
  "Set whether substitution is allowed for specific order lines. " +
  "Uses a toggle endpoint: fetches current state and only toggles lines that differ. " +
  "WARNING: Not idempotent due to toggle semantics. Do NOT retry on timeout — check current state first.",
  {
    token: z.string().describe("Order token"),
    lineIds: z.array(z.number().int()).describe("IDs of lines to update"),
    substitution: z.boolean().describe("Desired substitution state (true = allow, false = disallow)"),
  },
  async ({ token, lineIds, substitution }) => {
    return handleTool(() => getClient().setOrderSubstitution(token, lineIds, substitution));
  }
);

server.tool(
  "lower_order_quantity",
  "Reduce the quantity of specific order lines. Quantity can only be lowered. Set to 0 to remove.",
  {
    token: z.string().describe("Order token"),
    lineIds: z.array(z.number().int()).describe("IDs of lines to modify"),
    quantity: z.number().int().min(0).describe("New total quantity (must be lower than current)"),
  },
  async ({ token, lineIds, quantity }) => {
    return handleTool(() => getClient().lowerOrderQuantity(token, lineIds, quantity));
  }
);

// ── Product Lists ───────────────────────────────────────────────────

server.tool(
  "list_product_lists",
  "List saved product lists",
  {
    limit: z.number().int().min(1).optional().describe("Results per page"),
    offset: z.number().int().min(0).optional().describe("Starting index"),
  },
  async ({ limit, offset }) => {
    return handleTool(() => getClient().listProductLists({ limit, offset }));
  }
);

server.tool(
  "create_product_list",
  "Create a new product list",
  {
    name: z.string().max(100).describe("List name"),
    description: z.string().optional().describe("List description"),
  },
  async ({ name, description }) => {
    return handleTool(() => getClient().createProductList(name, description));
  }
);

server.tool(
  "get_product_list",
  "Get a product list with all items including product details and pricing",
  {
    token: z.string().describe("Product list UUID token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().getProductList(token));
  }
);

server.tool(
  "update_product_list",
  "Update the name or description of a product list",
  {
    token: z.string().describe("Product list UUID token"),
    name: z.string().max(100).optional().describe("New name"),
    description: z.string().optional().describe("New description"),
  },
  async ({ token, name, description }) => {
    return handleTool(() => getClient().updateProductList(token, { name, description }));
  }
);

server.tool(
  "delete_product_list",
  "Permanently delete a product list and all its items",
  {
    token: z.string().describe("Product list UUID token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().deleteProductList(token));
  }
);

server.tool(
  "clear_product_list",
  "Remove all items from a product list without deleting the list itself",
  {
    token: z.string().describe("Product list UUID token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().clearProductList(token));
  }
);

server.tool(
  "sort_product_list",
  "Sort items in the product list by store departments",
  {
    token: z.string().describe("Product list UUID token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().sortProductListItems(token));
  }
);

server.tool(
  "update_product_list_item",
  "Add a product by SKU or update its quantity in a product list. Set quantity to 0 to remove.",
  {
    token: z.string().describe("Product list UUID token"),
    sku: z.string().max(40).describe("Product SKU"),
    quantity: z.number().int().min(0).describe("Quantity (0 to remove)"),
  },
  async ({ token, sku, quantity }) => {
    return handleTool(() => getClient().updateProductListItem(token, sku, quantity));
  }
);

// ── Purchase Stats ──────────────────────────────────────────────────

server.tool(
  "list_purchase_stats",
  "List previously purchased products with frequency data, ordered by most recent purchase",
  {
    limit: z.number().int().min(1).optional().describe("Results per page"),
    offset: z.number().int().min(0).optional().describe("Starting index"),
    includeIgnored: z.boolean().optional().describe("Include ignored products"),
  },
  async ({ limit, offset, includeIgnored }) => {
    return handleTool(() => getClient().listPurchaseStats({ limit, offset, includeIgnored }));
  }
);

server.tool(
  "set_purchase_stat_ignored",
  "Hide or unhide a product from purchase history",
  {
    id: z.number().int().describe("Purchase stat ID"),
    isIgnored: z.boolean().describe("Whether to ignore this product"),
  },
  async ({ id, isIgnored }) => {
    return handleTool(() => getClient().setPurchaseStatIgnored(id, isIgnored));
  }
);

// ── Shopping Notes ──────────────────────────────────────────────────

server.tool("get_shopping_note", "Get the shopping note (auto-creates if none exists)", {}, async () => {
  return handleTool(() => getClient().getShoppingNote());
});

server.tool(
  "add_shopping_note_line",
  "Add a line to the shopping note. Provide exactly one of text (freeform) or sku (linked product), not both.",
  {
    text: z.string().max(3000).optional().describe("Freeform text for the line (mutually exclusive with sku)"),
    sku: z.string().max(32).optional().describe("Product SKU to link (mutually exclusive with text)"),
    quantity: z.number().int().min(0).optional().describe("Quantity"),
  },
  async ({ text, sku, quantity }) => {
    return handleTool(() => {
      if (!text && !sku) throw new Error("Either 'text' or 'sku' must be provided");
      if (text && sku) throw new Error("Provide either 'text' or 'sku', not both");
      return getClient().addShoppingNoteLine({ text, sku, quantity });
    });
  }
);

server.tool(
  "change_shopping_note_line",
  "Update the text or quantity of an existing shopping note line",
  {
    token: z.string().describe("Line UUID token"),
    text: z.string().max(255).optional().describe("New text"),
    quantity: z.number().int().min(0).optional().describe("New quantity"),
  },
  async ({ token, text, quantity }) => {
    return handleTool(() => getClient().changeShoppingNoteLine(token, { text, quantity }));
  }
);

server.tool(
  "reorder_shopping_note_lines",
  "Reorder shopping note lines by passing their tokens in desired order",
  {
    linesTokens: z.array(z.string()).describe("Line tokens in desired display order"),
  },
  async ({ linesTokens }) => {
    return handleTool(() => getClient().reorderShoppingNoteLines(linesTokens));
  }
);

server.tool(
  "delete_shopping_note_line",
  "Remove a line from the shopping note",
  {
    token: z.string().describe("Line UUID token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().deleteShoppingNoteLine(token));
  }
);

server.tool(
  "delete_archived_line",
  "Remove a specific archived shopping note line",
  {
    token: z.string().describe("Archived line UUID token"),
  },
  async ({ token }) => {
    return handleTool(() => getClient().deleteArchivedLine(token));
  }
);

server.tool("clear_shopping_note", "Delete all lines from the shopping note (the note itself is preserved)", {}, async () => {
  return handleTool(() => getClient().clearShoppingNote());
});

server.tool(
  "check_store_order_eligibility",
  "Check if the shopping note contains products that can be ordered from a store",
  {},
  async () => {
    return handleTool(() => getClient().checkStoreOrderEligibility());
  }
);

server.tool("list_archived_lines", "List previously completed and archived shopping note lines", {}, async () => {
  return handleTool(() => getClient().listArchivedLines());
});

server.tool(
  "apply_store_product_order",
  "Reorder shopping note lines to match the store's aisle layout for efficient in-store shopping",
  {},
  async () => {
    return handleTool(() => getClient().applyStoreProductOrder());
  }
);

server.tool(
  "set_line_completion",
  "Mark a shopping note line as completed or uncompleted. " +
  "Uses a toggle endpoint: fetches current state and only toggles if needed. " +
  "WARNING: Not idempotent due to toggle semantics. Do NOT retry on timeout — check current state first.",
  {
    token: z.string().describe("Line UUID token"),
    completed: z.boolean().describe("Desired completion state"),
  },
  async ({ token, completed }) => {
    return handleTool(() => getClient().setLineCompletion(token, completed));
  }
);

// ── Start ───────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
