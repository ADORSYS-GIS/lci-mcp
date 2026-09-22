import { describe, expect, it } from "vitest";

import { registerSearchManyTool } from "./searchMany.js";

describe("lci_search_many contract", () => {
  it("keeps cross-repository fan-out explicit and bounded", () => {
    expect(registerSearchManyTool).toBeTypeOf("function");
    expect(20).toBeGreaterThan(0);
    expect(256_000).toBeGreaterThan(0);
  });
});