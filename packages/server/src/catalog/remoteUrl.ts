// Shared Git remote-URL validation. Beyond http(s) and ssh:// URLs, real deployments hand us
// scp-style remotes (git@host:org/repo.git) and ssh URLs carrying a `git@` username — both of which
// `URL` parsing/`.url()` reject. Embedded passwords are never accepted (secrets must not live in a
// remote), and http(s) still forbids any embedded credentials.

// scp-style: [user@]host:path where the part after the colon is NOT a URL authority (no leading //).
const SCP_LIKE = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:(?!\/\/).+$/;

export function isValidRemoteUrl(value: string): boolean {
  if (SCP_LIKE.test(value) && !value.includes("://")) return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "ssh:") return !parsed.password;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return !parsed.username && !parsed.password;
    return false;
  } catch {
    return false;
  }
}

export const REMOTE_URL_MESSAGE =
  "remoteUrl must be an http(s)/ssh URL or scp-style git@host:path remote, without embedded credentials";
