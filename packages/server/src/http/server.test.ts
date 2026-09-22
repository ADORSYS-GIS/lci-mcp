import { describe, expect, it } from "vitest";

import { hasValidBearerToken } from "./server.js";

describe("HTTP MCP authentication", () => {
  it("accepts only an exact bearer token", () => {
    expect(hasValidBearerToken({ headers: { authorization: "Bearer a-secret-token-1234" } } as never, "a-secret-token-1234")).toBe(true);
    expect(hasValidBearerToken({ headers: { authorization: "Bearer wrong-token" } } as never, "a-secret-token-1234")).toBe(false);
    expect(hasValidBearerToken({ headers: {} } as never, "a-secret-token-1234")).toBe(false);
  });
});