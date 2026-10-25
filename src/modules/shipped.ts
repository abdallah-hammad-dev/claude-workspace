import type { WorkspaceModule } from "../core/module-api";
import type { ModuleOrigin, ModuleRegistry } from "../core/ModuleRegistry";

export interface ShippedModulesHost {
  /** Ids of the shipped modules the user deleted, from plugin data. */
  deleted(): string[];
  setDeleted(ids: string[]): Promise<void>;
  /** Drops a module's switch and settings. */
  forget(id: string): Promise<void>;
}

/**
 * The modules that ship with Claude Workspace. Those about Obsidian are built in. One written for another plugin
 * (it names a `plugin`) was written outside that plugin, so it is custom: the user can delete it, which leaves it
 * out until they restore it (its code stays in the bundle).
 */
export class ShippedModules {
  constructor(
    private readonly registry: ModuleRegistry,
    private readonly modules: WorkspaceModule[],
    private readonly host: ShippedModulesHost,
  ) {}

  /** Adds every module the user hasn't deleted. */
  add(): void {
    const deleted = this.host.deleted();
    for (const mod of this.modules) if (!deleted.includes(mod.id)) this.registry.add(mod, shippedOrigin(mod));
  }

  /** The modules the user deleted, to restore. */
  deleted(): WorkspaceModule[] {
    const deleted = this.host.deleted();
    return this.modules.filter((m) => deleted.includes(m.id));
  }

  async delete(id: string): Promise<void> {
    const mod = this.modules.find((m) => m.id === id);
    if (!mod || shippedOrigin(mod).kind !== "custom" || this.host.deleted().includes(id)) return;
    await this.registry.remove(id);
    await this.host.forget(id);
    await this.host.setDeleted([...this.host.deleted(), id]);
  }

  async restore(id: string): Promise<void> {
    const mod = this.deleted().find((m) => m.id === id);
    if (!mod) return;
    await this.host.setDeleted(this.host.deleted().filter((d) => d !== id));
    this.registry.add(mod, shippedOrigin(mod));
  }
}

export function shippedOrigin(mod: WorkspaceModule): ModuleOrigin {
  return mod.plugin ? { kind: "custom" } : { kind: "builtin" };
}
