import { createHash } from "node:crypto";

export type SecretKind = "bearer" | "api_key" | "basic_auth";
export const secretKinds: readonly SecretKind[] = ["bearer", "api_key", "basic_auth"];

/**
 * What the vault enforces on every use (the enforcement itself arrives with the handles, P6.3). Empty `tools`, `goals` and
 * `channels` mean no restriction on that axis; `hosts` is never empty, since a credential that may go anywhere is the
 * thing the design exists to prevent.
 */
export type SecretScope = {
  /** Exact host names or `*.suffix`, optionally `:port` (https only; 443 when no port is given). */
  hosts: string[];
  /** HTTP methods; GET only unless the user widened it. */
  methods: string[];
  tools: string[];
  goals: string[];
  channels: string[];
  /** Whether each use waits for the user's approval; on by default. */
  requiresApproval: boolean;
};

export class VaultError extends Error {}

const hostPattern = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
const methodSet = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/** Fills in the defaults and refuses a scope the vault could not enforce. Returns a normalized copy. */
export function normalizeScope(input: Partial<SecretScope> & { hosts: string[] }): SecretScope {
  const hosts = [...new Set(input.hosts.map((h) => h.trim().toLowerCase()))];
  if (hosts.length === 0) throw new VaultError("A secret needs at least one host it may be sent to.");
  for (const h of hosts) {
    if (h.startsWith("*.") && !h.slice(2).split(":")[0]?.includes("."))
      throw new VaultError(`"${h}" covers a whole top-level domain; name the domain it belongs to.`);
    if (!hostPattern.test(h))
      throw new VaultError(`"${h}" is not a host name (no scheme, path or wildcard except a leading *.).`);
    const port = h.split(":")[1];
    if (port !== undefined && Number(port) > 65535) throw new VaultError(`"${h}" has an impossible port.`);
  }
  const methods = [...new Set((input.methods ?? ["GET"]).map((m) => m.trim().toUpperCase()))];
  if (methods.length === 0) throw new VaultError("A secret needs at least one allowed method.");
  for (const m of methods) if (!methodSet.has(m)) throw new VaultError(`"${m}" is not an allowed method.`);
  const list = (values: string[] | undefined) =>
    [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort();
  return {
    hosts: hosts.sort(),
    methods: methods.sort(),
    tools: list(input.tools),
    goals: list(input.goals),
    channels: list(input.channels),
    requiresApproval: input.requiresApproval ?? true,
  };
}

/** Key order is fixed by `normalizeScope`, so the same scope always hashes the same. */
export function scopeHash(scope: SecretScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([scope.hosts, scope.methods, scope.tools, scope.goals, scope.channels, scope.requiresApproval]),
    )
    .digest("hex");
}
