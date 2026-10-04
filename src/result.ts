export function result(data: unknown) {
  // Void endpoints (HTTP 204) resolve to undefined, and JSON.stringify(undefined)
  // is undefined, which MCP rejects as a text content block.
  const payload = data === undefined ? { success: true } : data;
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
