import type { WorkspaceModule } from "../core/module-api";
import { helloModule } from "./dummy";

/** Modules shipped with the plugin. External plugins use `plugin.api.registerModule`. */
export const builtinModules: WorkspaceModule[] = [helloModule];
