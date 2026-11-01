import type { ArtifactStore } from "../artifacts.js";
import { createArtifactTool, findArtifactsTool, readArtifactTool } from "./artifacts.js";
import { ToolRegistry } from "./registry.js";
import { webFetchTool, webSearchTool } from "./web.js";

/** The built-in tools. web_search exists only when BRINDLE_SEARCH_URL names a search service. */
export function builtInTools(env: Record<string, string | undefined>, artifacts?: ArtifactStore): ToolRegistry {
  const registry = new ToolRegistry().register(
    webFetchTool({ allowPrivate: env.BRINDLE_WEB_FETCH_ALLOW_PRIVATE === "1" }),
  );
  const search = env.BRINDLE_SEARCH_URL?.trim();
  if (artifacts) {
    registry.register(createArtifactTool(artifacts));
    registry.register(findArtifactsTool(artifacts));
    registry.register(readArtifactTool(artifacts));
  }
  if (search) registry.register(webSearchTool(search));
  return registry;
}
