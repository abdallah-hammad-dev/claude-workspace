import type { WorkspaceModule } from "../core/module-api";
import { commandsModule } from "./commands";
import { excalidrawModule } from "./excalidraw";
import { markdownModule } from "./markdown";
import { obsidianModule } from "./obsidian";

/** Modules shipped with the plugin. External plugins use `plugin.api.registerModule`. */
export const builtinModules: WorkspaceModule[] = [obsidianModule, markdownModule, commandsModule, excalidrawModule];
