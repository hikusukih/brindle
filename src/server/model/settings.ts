import { existsSync, readFileSync } from "node:fs";

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
  for (const [spec, raw] of Object.entries(parsed)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ModelSettingsError(`${path}: the settings for "${spec}" must be an object.`);
    }
    const settings: Partial<ModelSettings> = {};
    for (const [key, value] of Object.entries(raw)) {
      if ((numeric as readonly string[]).includes(key)) {
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          throw new ModelSettingsError(`${path}: "${spec}" ${key} must be a positive whole number.`);
        }
        (settings as Record<string, number>)[key] = value;
      } else if (key === "warmCache") {
        if (typeof value !== "boolean")
          throw new ModelSettingsError(`${path}: "${spec}" warmCache must be true or false.`);
        settings.warmCache = value;
      } else {
        throw new ModelSettingsError(`${path}: "${spec}" has an unknown setting "${key}".`);
      }
    }
    out[spec] = settings;
  }
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
    private readonly defaultSpec?: string,
  ) {}

  /** The specs the settings file mentions, so startup can ask their servers for a window. */
  specs(): string[] {
    return Object.keys(this.file);
  }

  /** The window a server reported; used only when the file does not set one. */
  setServerWindow(spec: string, window: number) {
    this.windows.set(spec, window);
  }

  configuredWindow(spec: string): number | undefined {
    return this.file[spec]?.contextWindow;
  }

  forSpec(spec: string | null): ResolvedSettings {
    const model = spec ?? this.defaultSpec ?? "default";
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
      throw new ModelSettingsError(
        `${spec}: the configured contextWindow (${configured}) is larger than the server's (${server}). Lower it, or start the server with a larger context size.`,
      );
    }
    store.setServerWindow(spec, server);
  }
}
