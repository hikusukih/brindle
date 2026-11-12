import { ModelError } from "./adapter.js";

export type SseMessage = { event?: string; data: string };

/** Splits a streamed response body into server-sent event messages. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new ModelError("aborted", "The request was aborted.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.search(/\r?\n\r?\n/);
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
        const message = parseBlock(block);
        if (message) yield message;
        end = buffer.search(/\r?\n\r?\n/);
      }
    }
    const rest = parseBlock(buffer);
    if (rest) yield rest;
  } finally {
    reader.cancel().catch(() => {});
  }
}

function parseBlock(block: string): SseMessage | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}

/** Maps an HTTP failure to the one error type callers handle. */
export function httpError(status: number, detail: string): ModelError {
  // llama.cpp refuses a prompt larger than a slot's window with a 400 naming this error type. Retrying cannot help, and
  // the run should say it plainly instead of showing a raw server body.
  if (status === 400 && /exceed_context_size_error|exceeds the available context size/.test(detail))
    return new ModelError("invalid_request", "This conversation is too long for the model.", false);
  const message = `Model API answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
  if (status === 401 || status === 403) return new ModelError("auth", message);
  if (status === 429) return new ModelError("rate_limit", message);
  if (status >= 500) return new ModelError("unavailable", message);
  return new ModelError("invalid_request", message);
}

/** Turns a failed fetch into a ModelError, keeping aborts distinct from network trouble. */
export function networkError(error: unknown, signal?: AbortSignal): ModelError {
  if (error instanceof ModelError) return error;
  if (signal?.aborted) return new ModelError("aborted", "The request was aborted.");
  return new ModelError("unavailable", `Could not reach the model API: ${(error as Error).message}`);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("unavailable", "The model API sent a malformed stream event.");
  }
}
