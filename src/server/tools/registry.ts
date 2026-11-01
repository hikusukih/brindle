import type { ToolCall, ToolDefinition } from "../model/adapter.js";

/** What a tool may do, declared once per tool. `external` never runs without the user's approval. */
export type EffectLevel = "read" | "local" | "external";

const effectLevels: readonly string[] = ["read", "local", "external"];

/** Deliberately narrow: a tool reaches Brindle's state through functions it is given, never the database. */
export type ToolContext = {
  runId: string;
  scope: { kind: "channel"; id: string };
  signal: AbortSignal;
  log: (message: string) => void;
  /** Adds an event to the run's stream, such as the artifact a tool just made. */
  emit: (type: "artifact", data: Record<string, unknown>) => void;
};

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  effect: EffectLevel;
  /** Cap on what goes back to the model; the engine's global cap still applies. Defaults to 4,000. */
  maxResultTokens?: number;
  /** One line for the approval card, derived from the arguments. */
  describeCall?: (args: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /** Registering a tool without a valid effect level is a startup error, so it can't slip in unclassified. */
  register(tool: Tool): this {
    if (!tool.name) throw new Error("A tool needs a name.");
    if (!effectLevels.includes(tool.effect as string)) {
      throw new Error(`Tool "${tool.name}" must declare an effect level: read, local or external.`);
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}

/**
 * Whether a call must wait for the user. One function so a goal's standing permission (Phase 4) can
 * later answer false for a tool without the run loop changing.
 */
export function needsApproval(tool: Tool, _call: ToolCall, _scope: ToolContext["scope"]): boolean {
  return tool.effect === "external";
}

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
};

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string): string | null {
  if (schema.type) {
    const actual = typeOf(value);
    const ok = schema.type === "integer" ? Number.isInteger(value) : schema.type === actual;
    if (!ok) return `${path} must be ${schema.type === "integer" ? "an integer" : `a ${schema.type}`}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
  if (schema.type === "array" && schema.items) {
    for (const [i, item] of (value as unknown[]).entries()) {
      const problem = check(schema.items, item, `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  if (schema.type === "object" || schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] === undefined) continue;
      const problem = check(sub, obj[key], `${path}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

/**
 * Checks arguments against the small subset of JSON Schema the tools use (type, required, properties,
 * enum, items). Returns a message the model can read and correct, or null when the arguments are fine.
 */
export function validateArguments(tool: Tool, args: unknown): string | null {
  return check(tool.parameters as Schema, args, "arguments");
}
