export const PI_TOOL_NAMES = {
  context: "mg_context",
  activity: "mg_activity",
  follow_up: "mg_follow_up",
  complete: "mg_complete",
} as const;

export type PiToolName = typeof PI_TOOL_NAMES[keyof typeof PI_TOOL_NAMES];

export const PI_CONTEXT_VIEWS = [
  "work",
  "trajectory",
  "trajectory_full",
  "tooling",
  "health",
] as const;

export const PI_ACTIVITY_ACTIONS = [
  "event",
  "observe",
  "heartbeat",
  "propose",
  "create_child",
  "close_activity",
] as const;

export const PI_TOOL_SURFACE = Object.values(PI_TOOL_NAMES);

export const PI_AGENT_INSTRUCTION =
  "You are the merge-god PR agent in an isolated worktree. " +
  `Call ${PI_TOOL_NAMES.context} with view=work, perform the assigned work, and call ${PI_TOOL_NAMES.complete} exactly once. ` +
  `Use ${PI_TOOL_NAMES.activity} only for durable lifecycle changes or meaningful observations. ` +
  "Follow the policies and evidence requirements returned with the work item.";
