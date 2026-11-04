import type { ArtifactStore } from "../artifacts.js";
import type { Tool } from "./registry.js";

export type SpeechOptions = {
  /** The base of an OpenAI-compatible API, such as http://192.0.2.10:8880/v1; the request goes to <base>/audio/speech. */
  baseUrl: string;
  model: string;
  voice: string;
  /** Sent as a bearer token when the endpoint wants one. It comes from the environment, never from a file in the repo. */
  apiKey?: string;
  fetch?: typeof fetch;
};

// OpenAI's own limit on one request; a local server is rarely stricter.
const maxInputChars = 4_096;
const timeoutMs = 120_000;

/**
 * `local`: it sends the text to the speech server the operator configured, as the model adapters send their prompts
 * to the model server the operator configured, and writes only inside Brindle. It reaches nowhere the model server
 * does not already reach, so it needs no approval card.
 */
export function speakTool(store: ArtifactStore, options: SpeechOptions): Tool {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/audio/speech`;
  return {
    name: "speak",
    description: `Turn text into speech and save it as an audio artifact the user can play in the gallery. Give a short title and the text to read aloud (at most ${maxInputChars} characters). For a longer text, speak it in parts.`,
    effect: "local",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, text: { type: "string" } },
      required: ["title", "text"],
    },
    describeCall: (args) => `Speak "${String(args.title)}"`,
    async execute(args, ctx) {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) throw new Error("text must be something to say.");
      if (text.length > maxInputChars) throw new Error(`text is over ${maxInputChars} characters; speak it in parts.`);
      const res = await doFetch(url, {
        method: "POST",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: options.model, voice: options.voice, input: text, response_format: "mp3" }),
      });
      // The server's own error text is not repeated: it can echo the request, and nothing in it helps the model.
      if (!res.ok) throw new Error(`The speech server answered ${res.status}.`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const artifact = store.createAudio(
        { title: String(args.title), bytes, contentType: res.headers.get("content-type") ?? "" },
        { scope: ctx.scope.kind, scopeId: ctx.scope.id, runId: ctx.runId },
      );
      ctx.emit("artifact", { id: artifact.id, title: artifact.title, kind: artifact.kind });
      return `Saved audio "${artifact.title}" (${artifact.id}).`;
    },
  };
}
