import type { WorkspaceModule } from "../core/module-api";
import { helloModule } from "./dummy";
import { markdownModule } from "./markdown";
import { obsidianModule } from "./obsidian";

/** Modules shipped with the plugin. External plugins use `plugin.api.registerModule`. */
export const builtinModules: WorkspaceModule[] = [obsidianModule, markdownModule, helloModule];
