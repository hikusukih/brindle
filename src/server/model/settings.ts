import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Per-model numbers that need tuning against real hardware. No secrets: keys stay in environment variables. */
export type ModelSettings = {
  /** Tokens. */
  contextWindow: number;
  /** Model calls in one run. */
  maxSteps: number;
  /** Input plus output tokens summed over a run. */
  maxTokens: number;
  /** A run's time limit, in milliseconds. */
  maxMillis: number;
  /** Time limit of one housekeeping call, in milliseconds. */
  housekeepingMillis: number;
  /** Whether to send the new prompt after a fold so the next message reads only itself. */
  warmCache: boolean;
};

/** Starting guesses from docs/design/context.md, chosen for a CPU-only llama.cpp host. */
export const defaultModelSettings: ModelSettings = {
  contextWindow: 32_000,
  maxSteps: 10,
  maxTokens: 100_000,
  maxMillis: 5 * 60_000,
  housekeepingMillis: 10 * 60_000,
  warmCache: true,
};

export class ModelSettingsError extends Error {}

const numeric = [
  "contextWindow",
  "maxSteps",
  "maxTokens",
  "maxMillis",
  "housekeepingMillis",
] as const satisfies readonly (keyof ModelSettings)[];

/** Checks one model's entry, naming `where` (the file) in any error. Unknown keys and bad values throw. */
export function parseSettings(where: string, spec: string, raw: unknown): Partial<ModelSettings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ModelSettingsError(`${where}: the settings for "${spec}" must be an object.`);
  }
  const settings: Partial<ModelSettings> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((numeric as readonly string[]).includes(key)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new ModelSettingsError(`${where}: "${spec}" ${key} must be a positive whole number.`);
      }
      (settings as Record<string, number>)[key] = value;
    } else if (key === "warmCache") {
      if (typeof value !== "boolean")
        throw new ModelSettingsError(`${where}: "${spec}" warmCache must be true or false.`);
      settings.warmCache = value;
    } else {
      throw new ModelSettingsError(`${where}: "${spec}" has an unknown setting "${key}".`);
    }
  }
  return settings;
}

/** Reads {"<spec>": {...}}; a missing file means no settings. A bad file throws, since a silent default would hide the typo. */
export function loadModelSettings(
  path: string,
  read: (path: string) => string | undefined = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
): Record<string, Partial<ModelSettings>> {
  const text = read(path);
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ModelSettingsError(`${path} is not valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelSettingsError(`${path} must be an object keyed by model spec.`);
  }
  const out: Record<string, Partial<ModelSettings>> = {};
  for (const [spec, raw] of Object.entries(parsed)) out[spec] = parseSettings(path, spec, raw);
  return out;
}

export type ResolvedSettings = ModelSettings & {
  /** The spec the numbers belong to: the channel's own, else the default model's, else "default". */
  model: string;
};

/** Settings for a spec; a spec with none gets the defaults, and a null spec means the default model. */
export class ModelSettingsStore {
  private readonly windows = new Map<string, number>();

  constructor(
    private readonly file: Record<string, Partial<ModelSettings>> = {},
    // Asked on every lookup, since the default can be changed at runtime from Settings.
    private readonly defaultSpec: () => string | undefined = () => undefined,
    // A channel whose model is no longer configured runs on the default, so its numbers are the default's.
    private readonly isConfigured: (spec: string) => boolean = () => true,
  ) {}

  /** The specs the settings file mentions, so startup can ask their servers for a window. */
  specs(): string[] {
    return Object.keys(this.file);
  }

  /** The window a server reported; used only when the file does not set one. */
  setServerWindow(spec: string, window: number) {
    this.windows.set(spec, window);
  }

  /** The window the server reported, if it has been asked and answered. */
  serverWindow(spec: string): number | undefined {
    return this.windows.get(spec);
  }

  /** What the file holds for a spec, without the defaults. */
  entry(spec: string): Partial<ModelSettings> {
    return { ...this.file[spec] };
  }

  /** Replaces one model's entry for this process; an empty entry removes it. */
  replace(spec: string, entry: Partial<ModelSettings>) {
    if (Object.keys(entry).length) this.file[spec] = entry;
    else delete this.file[spec];
  }

  snapshot(): Record<string, Partial<ModelSettings>> {
    return structuredClone(this.file);
  }

  configuredWindow(spec: string): number | undefined {
    return this.file[spec]?.contextWindow;
  }

  forSpec(spec: string | null): ResolvedSettings {
    const chosen = spec && this.isConfigured(spec) ? spec : null;
    const model = chosen ?? this.defaultSpec() ?? "default";
    const own = this.file[model] ?? {};
    const window = own.contextWindow ?? this.windows.get(model);
    return { ...defaultModelSettings, ...own, ...(window ? { contextWindow: window } : {}), model };
  }
}

/** llama.cpp serves /props at its root; a configured base URL usually ends in /v1. */
function propsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/props`;
}

/** The context size one slot of an OpenAI-compatible local server really has, or undefined if it does not say. */
export async function serverContextWindow(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const res = await fetchFn(propsUrl(baseUrl), { signal: signal ?? AbortSignal.timeout(5_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { default_generation_settings?: { n_ctx?: unknown } };
    const n = body.default_generation_settings?.n_ctx;
    return typeof n === "number" && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For each local OpenAI-compatible spec, asks the server for its window. With none configured, the server's is used;
 * a configured one larger than the server's is a configuration error, since every long run would be rejected.
 */
export async function applyServerWindows(
  store: ModelSettingsStore,
  specs: string[],
  baseUrl: string | undefined,
  fetchFn: typeof fetch = fetch,
) {
  if (!baseUrl) return;
  for (const spec of new Set(specs)) {
    if (!spec.startsWith("openai:")) continue;
    const server = await serverContextWindow(baseUrl, fetchFn);
    if (!server) continue;
    const configured = store.configuredWindow(spec);
    if (configured !== undefined && configured > server) {
      throw new ModelSettingsError(windowTooLarge(spec, configured, server));
    }
    store.setServerWindow(spec, server);
  }
}

export const windowTooLarge = (spec: string, configured: number, server: number) =>
  `${spec}: the configured contextWindow (${configured}) is larger than the server's (${server}). Lower it, or start the server with a larger context size.`;

/**
 * Applies a change from the Settings screen to one model: each key is a new value or null to go back to the default.
 * Checked like the file is at startup, including the window against the server's, so a bad value is refused instead of
 * saved; then written whole, through a temporary file, so a crash never leaves half a file.
 */
export async function updateModelSettings(
  store: ModelSettingsStore,
  path: string,
  spec: string,
  patch: Record<string, unknown>,
  options: { baseUrl?: string; fetch?: typeof fetch; write?: (path: string, text: string) => void } = {},
): Promise<void> {
  const cleared = Object.entries(patch)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  const next: Record<string, unknown> = { ...store.entry(spec), ...parseSettings("The settings", spec, given) };
  for (const key of cleared) {
    if (!Object.hasOwn(defaultModelSettings, key))
      throw new ModelSettingsError(`The settings: "${spec}" has an unknown setting "${key}".`);
    delete next[key];
  }
  let server = store.serverWindow(spec);
  if (server === undefined && spec.startsWith("openai:") && options.baseUrl) {
    server = await serverContextWindow(options.baseUrl, options.fetch);
    if (server !== undefined) store.setServerWindow(spec, server);
  }
  const window = next.contextWindow;
  if (typeof window === "number" && server !== undefined && window > server)
    throw new ModelSettingsError(windowTooLarge(spec, window, server));
  const before = store.entry(spec);
  store.replace(spec, next as Partial<ModelSettings>);
  const write =
    options.write ??
    ((target: string, text: string) => {
      writeFileSync(`${target}.tmp`, text);
      renameSync(`${target}.tmp`, target);
    });
  try {
    write(path, `${JSON.stringify(store.snapshot(), null, 2)}\n`);
  } catch (error) {
    store.replace(spec, before);
    throw error;
  }
}

export type ModelSettingsView = {
  spec: string;
  /** What the file holds: only the numbers the user set. */
  configured: Partial<ModelSettings>;
  /** What a run on this model uses, defaults filled in. */
  effective: ModelSettings;
  /** The window the server reports, or null if it has none to report (a hosted model, or a server that is down). */
  serverWindow: number | null;
  /** Set when the configured window is larger than the server's: the same message startup refuses with. */
  problem: string | null;
};

/** One entry for each model the Settings screen lists, asking a local server for its window the first time. */
export async function describeModelSettings(
  store: ModelSettingsStore,
  specs: string[],
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<ModelSettingsView[]> {
  return Promise.all(
    specs.map(async (spec) => {
      if (store.serverWindow(spec) === undefined && spec.startsWith("openai:") && options.baseUrl) {
        const window = await serverContextWindow(options.baseUrl, options.fetch);
        if (window !== undefined) store.setServerWindow(spec, window);
      }
      const server = store.serverWindow(spec) ?? null;
      const configured = store.entry(spec);
      const { model: _model, ...effective } = store.forSpec(spec);
      return {
        spec,
        configured,
        effective,
        serverWindow: server,
        problem:
          server !== null && configured.contextWindow !== undefined && configured.contextWindow > server
            ? windowTooLarge(spec, configured.contextWindow, server)
            : null,
      };
    }),
  );
}
