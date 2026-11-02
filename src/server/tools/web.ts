import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool } from "./registry.js";

export type WebOptions = {
  fetch?: typeof fetch;
  /** Resolves a host name to its addresses; tests replace it so they need no network. */
  resolve?: (host: string) => Promise<string[]>;
  /** For an operator who wants the agent to reach their own network. Off by default. */
  allowPrivate?: boolean;
};

const maxBytes = 2_000_000;
const maxRedirects = 5;
const timeoutMs = 15_000;

function privateV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. A dotted IPv4 tail counts as two groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const tail = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const q = tail.slice(2).map(Number);
    if (q.some((n) => n > 255)) return null;
    text = `${tail[1]}${((q[0] ?? 0) * 256 + (q[1] ?? 0)).toString(16)}:${((q[2] ?? 0) * 256 + (q[3] ?? 0)).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const part = (h: string) => (h === "" ? [] : h.split(":"));
  const head = part(halves[0] ?? "");
  const rest = halves.length === 2 ? part(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

function privateAddress(address: string): boolean {
  const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]));
  const g = ipv6Groups(address);
  // Anything that isn't a readable address is refused rather than guessed at.
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0] = g;
  // The IPv4 rules only look at the first two octets, which sit in one group.
  const embedded = (group: number) => privateV4(group >> 8, group & 0xff);
  // Forms that carry an IPv4 address inside an IPv6 one. A URL normalizes them to hex
  // (http://[::ffff:127.0.0.1]/ becomes [::ffff:7f00:1]), so the IPv4 rules must apply to them too.
  // ::/96 (compatible, which also covers :: and ::1) and ::ffff:0:0/96 (mapped):
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) return embedded(g6);
  // ::ffff:0:0:0/96 (translated):
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return embedded(g6);
  // 64:ff9b::/96 (NAT64), and 64:ff9b:1::/48, which is for local networks only:
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 1 || embedded(g6);
  // 2002::/16 (6to4) carries the address in the second and third groups:
  if (g0 === 0x2002) return embedded(g1);
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local, deprecated but still routed by some networks
    (g0 & 0xff00) === 0xff00 // multicast
  );
}

/** Refuses hosts that point inside the machine or its network, so a page can't steer the model at them. */
async function checkHost(url: URL, options: WebOptions) {
  if (options.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`${host} is a local address; web_fetch only reaches the public internet.`);
  }
  const addresses = isIP(host) ? [host] : await (options.resolve ?? defaultResolve)(host);
  if (addresses.some(privateAddress)) {
    throw new Error(`${host} resolves to a private address; web_fetch only reaches the public internet.`);
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Readable text from HTML: scripts, styles and markup go, block boundaries become line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return entities[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

/** Fetches a public page with GET, no body and no credential, which is why it can stay `read`. */
export function webFetchTool(options: WebOptions = {}): Tool {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "web_fetch",
    description:
      "Fetch a web page or text document by URL and return it as readable text. Only public http and https addresses.",
    effect: "read",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(args, ctx) {
      let url: URL;
      try {
        url = new URL(String(args.url));
      } catch {
        throw new Error(`"${String(args.url)}" is not a valid URL.`);
      }
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      for (let hops = 0; ; hops++) {
        if (url.protocol !== "http:" && url.protocol !== "https:")
          throw new Error("Only http and https URLs can be fetched.");
        await checkHost(url, options);
        const res = await doFetch(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: {
            accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
            "user-agent": "Brindle/0.0 (+self-hosted agent)",
          },
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          if (hops >= maxRedirects) throw new Error("Too many redirects.");
          url = new URL(location, url);
          continue;
        }
        if (!res.ok) throw new Error(`${url.href} answered ${res.status}.`);
        const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
        const body = await readCapped(res);
        if (type === "text/html" || type === "application/xhtml+xml") return htmlToText(body);
        if (type.startsWith("text/") || type.includes("json") || type.includes("xml") || type === "") return body;
        throw new Error(`${url.href} is ${type}, which can't be read as text.`);
      }
    },
  };
}

type SearchHit = { title?: unknown; url?: unknown; content?: unknown };

/** Searches through a SearXNG-style JSON endpoint the operator points BRINDLE_SEARCH_URL at; no key is involved. */
export function webSearchTool(baseUrl: string, options: Pick<WebOptions, "fetch"> = {}): Tool {
  const doFetch = options.fetch ?? fetch;
  return {
    name: "web_search",
    description: "Search the web and return titles, addresses and snippets of the top results.",
    effect: "read",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, count: { type: "integer" } },
      required: ["query"],
    },
    async execute(args, ctx) {
      const url = new URL(`${baseUrl.replace(/\/$/, "")}/search`);
      url.searchParams.set("q", String(args.query));
      url.searchParams.set("format", "json");
      const res = await doFetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) });
      if (!res.ok) throw new Error(`The search service answered ${res.status}.`);
      const body = (await res.json().catch(() => null)) as { results?: SearchHit[] } | null;
      if (!Array.isArray(body?.results))
        throw new Error("The search service gave an answer that isn't search results.");
      const count = typeof args.count === "number" ? Math.min(Math.max(args.count, 1), 20) : 8;
      const hits = body.results.slice(0, count);
      if (!hits.length) return "No results.";
      return hits
        .map(
          (h, i) =>
            `${i + 1}. ${String(h.title ?? "(untitled)")}\n   ${String(h.url ?? "")}\n   ${String(h.content ?? "").trim()}`,
        )
        .join("\n\n");
    },
  };
}
