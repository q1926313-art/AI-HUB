// AI Hub: observe the team's existing terminals without starting another agent.
// Visibility is owned by one live Team view; persisted preferences never arm work.
export const WORKSPACE_KEY = "ai-hub.team.workspace.v1";
export const SLOTS = ["left", "top", "bottom"];
export const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const DEFAULT_CHOICES = { left: "agent:claude", top: "agent:codex", bottom: "agent:opencode" };
const started = (stage) => stage && (stage.attempt > 0 || stage.startedAt != null || !["pending"].includes(stage.status));
const owned = (terminal, current, stage) => terminal?.labels?.["aihub.run"] === current.id
  && terminal.labels["aihub.stage"] === stage.id
  && terminal.labels["aihub.attempt"] === String(stage.attempt);

export function choicesFor(current) {
  const agents = [...new Set((current?.stages ?? []).map((stage) => stage.agent))];
  return [
    ...agents.map((agent) => ({ id: "agent:" + agent, name: (TOOL_NAMES[agent] ?? agent) + " · 현재 역할 따라가기" })),
    ...(current?.stages ?? []).map((stage) => ({ id: "stage:" + stage.id, name: stage.roleName + " · " + (TOOL_NAMES[stage.agent] ?? stage.agent) })),
  ];
}

export function preferences(current, value) {
  const valid = new Set(choicesFor(current).map((choice) => choice.id));
  const agents = [...new Set((current?.stages ?? []).map((stage) => stage.agent))];
  const defaults = { ...DEFAULT_CHOICES };
  // Keep the requested positions whenever those tools are assigned. Custom-only
  // teams use their actual tools, rather than showing three unrelated empty panes.
  const used = new Set(Object.values(defaults).filter((choice) => valid.has(choice)));
  for (const slot of SLOTS) {
    if (!valid.has(defaults[slot])) {
      const next = agents.map((agent) => "agent:" + agent).find((choice) => !used.has(choice));
      if (next) { defaults[slot] = next; used.add(next); }
    }
  }
  return {
    ratio: [55, 65, 75].includes(value?.ratio) ? value.ratio : 65,
    choices: Object.fromEntries(SLOTS.map((slot) => [slot,
      valid.has(value?.choices?.[slot]) ? value.choices[slot] : defaults[slot],
    ])),
  };
}

export function selectStage(current, choice) {
  const stages = current?.stages ?? [];
  if (choice?.startsWith("stage:")) return stages.find((stage) => stage.id === choice.slice(6)) ?? null;
  const matching = stages.filter((stage) => "agent:" + stage.agent === choice);
  // A future Claude verification step must not hide its running planning step.
  // A retry without a terminal must not fall back to a previous attempt either.
  return matching.filter(started).at(-1) ?? matching[0] ?? null;
}

export function bindingsFor(current, live = [], prefs) {
  const selected = preferences(current, prefs);
  const used = new Set();
  return SLOTS.map((slot) => {
    const choice = selected.choices[slot];
    const stage = selectStage(current, choice);
    const candidates = stage ? live.filter((terminal) => owned(terminal, current, stage)) : [];
    const terminal = candidates.length === 1
      && (!stage.terminal || candidates[0].address === stage.terminal) ? candidates[0] : null;
    const address = terminal?.address && !used.has(terminal.address) ? terminal.address : null;
    const duplicate = Boolean(terminal?.address && used.has(terminal.address));
    if (address) used.add(address);
    return { slot, choice, stageId: stage?.id ?? null, attempt: stage?.attempt ?? 0, terminal: address, duplicate };
  });
}

export function workspaceLayout(current, live, prefs, owner, generation) {
  const selected = preferences(current, prefs);
  const common = { runId: current.id, owner, generation };
  const bindings = bindingsFor(current, live, selected);
  const mod = (role, extra = {}) => ({ mod: "team-workspace", props: { ...common, role, ...extra } });
  const pane = (slot) => {
    const binding = bindings.find((item) => item.slot === slot);
    return {
      id: "team-" + slot, type: "column", resizable: false, min: 160,
      size: { weight: slot === "left" ? selected.ratio : 1 },
      background: "background", border: { width: 1, color: "border" }, radius: 8,
      children: [
        { id: "team-" + slot + "-header", type: "block", size: { px: 68 }, content: mod("header", { binding }) },
        { id: "team-" + slot + "-terminal", type: "block", content: binding.terminal ? { terminal: binding.terminal } : mod("placeholder", { binding }) },
      ],
    };
  };
  return {
    id: "team-workspace", type: "column", resizable: false, background: "chrome", gap: 8, padding: 8,
    children: [
      { id: "team-workspace-toolbar", type: "block", size: { px: 76 }, content: mod("toolbar") },
      { id: "team-workspace-body", type: "row", resizable: false, gap: 8, children: [
        pane("left"),
        { id: "team-workspace-right", type: "column", resizable: false, gap: 8, size: { weight: 100 - selected.ratio }, children: [pane("top"), pane("bottom")] },
      ] },
    ],
  };
}

export function dismissWorkspace(host, owner, generation) {
  const state = host.shared(WORKSPACE_KEY);
  if (!state?.open || state.owner !== owner || state.generation !== generation) return false;
  host.setShared(WORKSPACE_KEY, { ...state, open: false, dismissed: (state.dismissed || 0) + 1 });
  return true;
}

export function changeWorkspace(host, owner, generation, patch) {
  const state = host.shared(WORKSPACE_KEY);
  if (!state?.open || state.owner !== owner || state.generation !== generation) return false;
  host.setShared(WORKSPACE_KEY, { ...state, ...patch });
  return true;
}

export function createWorkspace(host) {
  const owner = "viewer-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  let overlay = null, fingerprint = null, generation = 0;
  const show = (current, force = false) => {
    if (!current?.id) return null;
    const state = host.shared(WORKSPACE_KEY);
    if (!force && (!state?.open || state.owner !== owner || state.runId !== current.id)) return null;
    const prefs = preferences(current, state?.runId === current.id ? state : null);
    const live = host.terminals();
    const bindings = bindingsFor(current, live, prefs);
    const signature = JSON.stringify({ runId: current.id, ...prefs, bindings });
    if (!force && signature === fingerprint) return overlay;
    generation++;
    // Publish the replacement generation first: closing the previous toolbar
    // must not clear the new viewer's intent. A user close does clear it.
    host.setShared(WORKSPACE_KEY, { owner, generation, runId: current.id, open: true,
      dismissed: state?.owner === owner ? state.dismissed || 0 : 0, ...prefs });
    try {
      overlay = host.openOverlay({
        kind: "window", key: "ai-team-workspace", width: 0.96, height: 0.94,
        layout: workspaceLayout(current, live, prefs, owner, generation),
      });
      fingerprint = signature;
      return overlay;
    } catch (error) {
      dismissWorkspace(host, owner, generation);
      throw error;
    }
  };
  return {
    open(current) { return show(current, true); },
    autoOpenToken() {
      const state = host.shared(WORKSPACE_KEY);
      return { owner: state?.owner ?? null, dismissed: state?.dismissed || 0 };
    },
    autoOpen(current, token) {
      const state = host.shared(WORKSPACE_KEY);
      // A delayed launch must not undo a close made while it was preparing.
      // Returning to Team before clicking Start/Next is a fresh request.
      if (state?.owner === owner && (state.dismissed || 0) > (token?.owner === owner ? token.dismissed : 0)) return null;
      if (state?.owner && state.owner !== owner && state.owner !== token?.owner) return null;
      return show(current, !(state?.open && state.owner === owner && state.runId === current?.id));
    },
    sync(current) { return show(current); },
    close() {
      const state = host.shared(WORKSPACE_KEY);
      if (state?.owner === owner) dismissWorkspace(host, owner, state.generation);
      if (overlay) host.closeOverlay(overlay);
      overlay = null;
      fingerprint = null;
    },
  };
}
