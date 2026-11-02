# Attention subscriptions

Proposed direction, October 23, 2026. UI ownership revised October 28, 2026.

An Interest holds task instructions. Its subscriptions specify when to wake the agent and an optional delivery address. Instructions belong to the Interest, not individual subscriptions. Agents create Interests and their watches through tools.

Event watches, timers and plugin sources remain distinct trigger types with shared scheduling and delivery. Preserve existing saved objects, timer budgets and producer completion. The bundled Attention plugin (`buzz.watching`) owns inspecting, pausing and deleting existing watches, in an Attention tab on each agent on this computer.
