import { describe, expect, it } from "vitest";

import { isValidRemoteUrl } from "./remoteUrl.js";

describe("remote URL validation", () => {
  it("accepts http(s) and ssh URLs, including a git@ username", () => {
    expect(isValidRemoteUrl("https://git.example.test/team/repo.git")).toBe(true);
    expect(isValidRemoteUrl("http://git.example.test/team/repo")).toBe(true);
    expect(isValidRemoteUrl("ssh://git@git.example.test/team/repo.git")).toBe(true);
  });

  it("accepts scp-style remotes", () => {
    expect(isValidRemoteUrl("git@git.example.test:team/repo.git")).toBe(true);
    expect(isValidRemoteUrl("git.example.test:team/repo.git")).toBe(true);
  });

  it("rejects embedded passwords and unsupported schemes", () => {
    expect(isValidRemoteUrl("https://user:secret@git.example.test/a")).toBe(false);
    expect(isValidRemoteUrl("ssh://git:secret@git.example.test/a")).toBe(false);
    expect(isValidRemoteUrl("ftp://git.example.test/a")).toBe(false);
    expect(isValidRemoteUrl("not a url")).toBe(false);
  });
});
