// Octopus Orchestrator — in-process runtime registry.
//
// Holds a reference to the initialized OctopusInstance so that code paths
// inside the same Gateway process (notably the /octo chat slash command
// handler in src/auto-reply/reply/commands-octo.ts) can reach the services
// without threading the instance through every call site.
//
// initOctopus() registers the instance on success; shutdown() clears it.
// Consumers must handle the null case (octo disabled or init failed).

import type { OctopusInstance } from "./index.ts";

let current: OctopusInstance | null = null;

export function setOctoRuntimeInstance(instance: OctopusInstance | null): void {
  current = instance;
}

export function getOctoRuntimeInstance(): OctopusInstance | null {
  return current;
}
