// The one contract every model backend implements. The run engine only ever sees this.

export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ModelRequest = {
  messages: Message[];
  tools?: ToolDefinition[];
  /** Aborting must end the stream promptly with a ModelError of kind "aborted". */
  signal?: AbortSignal;
};

export type Usage = {
  /** Every input token of the request, whether or not the server read it from its cache. */
  inputTokens: number;
  outputTokens: number;
  /** The part of inputTokens the server served from its prompt cache; absent when the server doesn't say. */
  cachedInputTokens?: number;
};

export type StopReason = "end" | "tool_use" | "length";

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  // Always the last event of a stream that did not throw.
  | { type: "done"; stop: StopReason; usage: Usage };

export type ModelErrorKind = "rate_limit" | "unavailable" | "invalid_request" | "auth" | "aborted";

/** The only error type an adapter may throw, so callers can decide on retry and on what to show. */
export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly retryable = kind === "rate_limit" || kind === "unavailable",
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
