import type { ArtifactStore } from "../artifacts.js";
import { createArtifactTool, findArtifactsTool, readArtifactTool } from "./artifacts.js";
import { ToolRegistry } from "./registry.js";
import { speakTool } from "./speak.js";
import { webFetchTool, webSearchTool } from "./web.js";

/**
 * The built-in tools. web_search exists only when BRINDLE_SEARCH_URL names a search service, and speak only when
 * BRINDLE_SPEECH_URL names an OpenAI-compatible speech endpoint (with BRINDLE_SPEECH_MODEL, BRINDLE_SPEECH_VOICE and
 * BRINDLE_SPEECH_API_KEY as needed).
 */
export function builtInTools(env: Record<string, string | undefined>, artifacts?: ArtifactStore): ToolRegistry {
  const registry = new ToolRegistry().register(
    webFetchTool({ allowPrivate: env.BRINDLE_WEB_FETCH_ALLOW_PRIVATE === "1" }),
  );
  const search = env.BRINDLE_SEARCH_URL?.trim();
  if (artifacts) {
    registry.register(createArtifactTool(artifacts));
    registry.register(findArtifactsTool(artifacts));
    registry.register(readArtifactTool(artifacts));
    const speech = env.BRINDLE_SPEECH_URL?.trim();
    if (speech) {
      registry.register(
        speakTool(artifacts, {
          baseUrl: speech,
          model: env.BRINDLE_SPEECH_MODEL?.trim() || "tts-1",
          voice: env.BRINDLE_SPEECH_VOICE?.trim() || "alloy",
          apiKey: env.BRINDLE_SPEECH_API_KEY?.trim() || undefined,
        }),
      );
    }
  }
  if (search) registry.register(webSearchTool(search));
  return registry;
}
