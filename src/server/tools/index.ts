import type { ArtifactStore } from "../artifacts.js";
import type { GoalStateAccess } from "../goal-state.js";
import { createArtifactTool, findArtifactsTool, readArtifactTool } from "./artifacts.js";
import { getGoalStateTool, updateGoalStateTool } from "./goal-state.js";
import { ToolRegistry } from "./registry.js";
import { webFetchTool, webSearchTool } from "./web.js";

/** The built-in tools. web_search exists only when BRINDLE_SEARCH_URL names a search service. */
export function builtInTools(
  env: Record<string, string | undefined>,
  artifacts?: ArtifactStore,
  goalState?: GoalStateAccess,
): ToolRegistry {
  const registry = new ToolRegistry().register(
    webFetchTool({ allowPrivate: env.BRINDLE_WEB_FETCH_ALLOW_PRIVATE === "1" }),
  );
  const search = env.BRINDLE_SEARCH_URL?.trim();
  if (artifacts) {
    registry.register(createArtifactTool(artifacts));
    registry.register(findArtifactsTool(artifacts));
    registry.register(readArtifactTool(artifacts));
  }
  if (goalState) registry.register(getGoalStateTool(goalState)).register(updateGoalStateTool(goalState));
  if (search) registry.register(webSearchTool(search));
  return registry;
}
