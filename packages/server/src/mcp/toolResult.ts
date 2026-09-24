export function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// The MCP SDK turns any thrown error into an `isError` result carrying its raw message, which for
// catalog/engine failures embeds absolute filesystem paths. Only messages that name repositories or
// policy (never paths/credentials) are surfaced; everything else collapses to a generic message.
export function sanitizeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("repository ") || message === "repository_id is required for this MCP server") {
    return message;
  }
  return "request failed";
}
