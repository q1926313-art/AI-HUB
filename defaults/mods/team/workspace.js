// AI Hub: one persistent native workspace tab for the team's actual terminals.
// The manager tab owns execution; this module only arranges already-owned work.
export const WORKSPACE_KEY = "ai-hub.team.workspace.v1";
export const SLOTS = ["left", "top", "bottom"];
export const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const DEFAULT_CHOICES = { left: "agent:claude", top: "agent:codex", bottom: "agent:opencode" };
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const started = (stage) => stage && (stage.attempt > 0 || stage.startedAt != null || stage.status !== "pending");
const owned = (terminal, current, stage) => terminal?.labels?.["aihub.run"] === current.id
  && terminal.labels["aihub.stage"] === stage.id
  && terminal.labels["aihub.attempt"] === String(stage.attempt);
const walk = (node) => node ? [node, ...(node.children ?? []).flatMap(walk)] : [];
const terminalAddresses = (root) => walk(root).map((node) => node.content?.terminal).filter(Boolean);
const alive = (terminal) => terminal?.state !== "finished";
const layoutConflict = (error) => String(error?.message ?? error)
  .includes("tab.layout changed; read it again before saving");

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
    picker: SLOTS.includes(value?.picker) ? value.picker : null,
  };
}

export function selectStage(current, choice) {
  const stages = current?.stages ?? [];
  if (choice?.startsWith("stage:")) return stages.find((stage) => stage.id === choice.slice(6)) ?? null;
  const matching = stages.filter((stage) => "agent:" + stage.agent === choice);
  return matching.filter(started).at(-1) ?? matching[0] ?? null;
}

export function bindingsFor(current, live = [], prefs) {
  const selected = preferences(current, prefs), used = new Set();
  return SLOTS.map((slot) => {
    const choice = selected.choices[slot], stage = selectStage(current, choice);
    const candidates = stage ? live.filter((terminal) => alive(terminal) && owned(terminal, current, stage)) : [];
    const terminal = candidates.length === 1 && (!stage.terminal || candidates[0].address === stage.terminal) ? candidates[0] : null;
    const address = terminal?.address && !used.has(terminal.address) ? terminal.address : null;
    const duplicate = Boolean(terminal?.address && used.has(terminal.address));
    if (address) used.add(address);
    return { slot, choice, stageId: stage?.id ?? null, attempt: stage?.attempt ?? 0, terminal: address, duplicate };
  });
}

export function workspaceLayout(current, live, prefs, owner, generation, context = {}, existingRoot = null) {
  const selected = preferences(current, prefs), bindings = bindingsFor(current, live, selected);
  const tabId = context.workspaceTabId || "team-workspace", prefix = tabId + "-team-";
  const common = { runId: current.id, owner, generation, ...context };
  const mod = (role, extra = {}) => ({ mod: "team", props: { ...common, view: "workspace", role, ...extra } });
  const pane = (slot) => {
    const binding = bindings.find((item) => item.slot === slot);
    return {
      id: prefix + slot, type: "column", resizable: false, min: 160,
      size: { weight: slot === "left" ? selected.ratio : 1 },
      background: "background", border: { width: 1, color: "border" }, radius: 8,
      children: [
        { id: prefix + slot + "-header", type: "block", closable: false, size: { px: 68 }, content: mod("header", { binding }) },
        { id: prefix + slot + "-terminal", type: "block", content: binding.terminal ? { terminal: binding.terminal } : mod("placeholder", { binding }) },
      ],
    };
  };
  const children = [
    { id: prefix + "toolbar", type: "block", closable: false, size: { px: 76 }, content: mod("toolbar") },
    ...(selected.picker ? [{ id: prefix + "picker", type: "block", closable: false, size: { px: 248 }, content: mod("picker", { binding: bindings.find((item) => item.slot === selected.picker) }) }] : []),
    { id: prefix + "body", type: "row", resizable: false, gap: 8, children: [
      pane("left"),
      { id: prefix + "right", type: "column", resizable: false, gap: 8, size: { weight: 100 - selected.ratio }, children: [pane("top"), pane("bottom")] },
    ] },
  ];
  // Keep earlier attempts/roles in this same tab. Removing their model panes
  // would make core's keep labels adopt them again as extra visible splits.
  const shown = new Set(bindings.map((binding) => binding.terminal).filter(Boolean));
  const archived = [...new Set(terminalAddresses(existingRoot))].filter((address) => !shown.has(address)).sort();
  if (archived.length) children.push({ id: prefix + "archive", type: "column", hidden: true,
    children: archived.map((terminal, index) => ({ id: prefix + "archive-" + index, type: "block", content: { terminal } })),
  });
  return { id: tabId, type: "column", movable: false, resizable: false, background: "chrome", gap: 8, padding: 8, children };
}

export function dismissWorkspace(host, owner, generation) {
  const state = host.shared(WORKSPACE_KEY);
  if (!state?.open || state.owner !== owner || state.generation !== generation) return false;
  host.setShared(WORKSPACE_KEY, { ...state, open: false, dismissed: (state.dismissed || 0) + 1, revision: (state.revision || 0) + 1 });
  return true;
}

export function changeWorkspace(host, owner, generation, patch) {
  const state = host.shared(WORKSPACE_KEY);
  if (!state?.open || state.owner !== owner || state.generation !== generation) return false;
  host.setShared(WORKSPACE_KEY, { ...state, ...patch, revision: (state.revision || 0) + 1 });
  return true;
}

export function createWorkspace(host) {
  const placement = copy(host.placement);
  const owner = "viewer-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  let closed = false, fingerprint = null, generation = 0, queue = Promise.resolve(), pendingSync = null, firstSync = true;
  const enqueue = (action) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const space = () => {
    if (closed || !placement?.spaceId || !placement?.tabId) return null;
    const value = host.spaces().find((item) => item.id === placement.spaceId && !item.machine && item.mod === "team");
    return value?.tabs?.some((tab) => tab.id === placement.tabId && tab.managed && tab.manager) ? value : null;
  };
  const requireSpace = () => {
    const value = space();
    if (!value) throw new Error("AI 팀 스페이스의 관리 탭에서 작업 화면을 열어 주세요.");
    return value;
  };
  const invoke = async (name, args) => {
    const reply = await host.command(name, args);
    if (reply?.error) throw new Error(String(reply.error));
    return reply;
  };
  const ownedRoot = (root) => walk(root).some((node) => node.content?.mod === "team"
    && node.content.props?.view === "workspace" && node.content.props.spaceId === placement?.spaceId
    && node.content.props.managerTabId === placement?.tabId);
  const readTab = async (id) => {
    const currentSpace = requireSpace();
    const tab = currentSpace.tabs.find((entry) => entry.id === id && entry.managed && !entry.manager);
    if (!tab) return null;
    const result = await invoke("tab.layout", { id });
    if (result?.space !== placement.spaceId || result?.tab !== id || !ownedRoot(result.layout)) {
      throw new Error("작업 탭의 소유 정보를 확인하지 못했습니다.");
    }
    return result;
  };
  const locate = async (state) => {
    const currentSpace = requireSpace();
    if (state?.spaceId === placement.spaceId && state?.managerTabId === placement.tabId && state?.tabId) {
      return readTab(state.tabId);
    }
    const found = [];
    for (const tab of currentSpace.tabs.filter((item) => item.managed && !item.manager)) {
      const result = await invoke("tab.layout", { id: tab.id });
      if (result?.space === placement.spaceId && ownedRoot(result.layout)) found.push(result);
    }
    if (found.length > 1) throw new Error("이 팀에 연결된 작업 탭이 여러 개입니다. 기존 작업 탭을 확인해 주세요.");
    return found[0] ?? null;
  };
  const ensureUnmodifiedControls = (root, tabId) => {
    for (const node of walk(root)) {
      if (!node.content?.mod) continue;
      const content = node.content;
      if (content.mod !== "team" || content.props?.view !== "workspace"
        || content.props.spaceId !== placement.spaceId || content.props.managerTabId !== placement.tabId) {
        throw new Error("작업 탭에 다른 패널이 추가되어 있습니다. 해당 구성을 보존하기 위해 자동 배치를 멈췄습니다.");
      }
    }
    if (root.id !== tabId) throw new Error("작업 탭 식별 정보가 일치하지 않습니다.");
  };
  const show = async (current, { explicit = false, focus = false, stageId = null, restore = false } = {}) => {
    if (closed || !current?.id) return null;
    const currentSpace = space();
    if (!currentSpace) {
      if (explicit) requireSpace();
      return null;
    }
    let state = host.shared(WORKSPACE_KEY);
    if (!explicit && !restore && (!state?.open || state.owner !== owner || state.runId !== current.id)) return null;
    let record = await locate(state);
    if (closed || !space()) return null;
    // A user-closed tab is not recreated by a timer, a new owner, or a late reply.
    if (!record && !explicit) {
      if (state?.owner === owner) dismissWorkspace(host, owner, state.generation);
      fingerprint = null;
      return null;
    }
    const oldDismissed = state?.dismissed || 0;
    if (!record) {
      generation++;
      const info = { view: "workspace", role: "opening", runId: current.id, owner, generation,
        spaceId: placement.spaceId, managerTabId: placement.tabId };
      const created = await invoke("tab.new", { space: placement.spaceId, name: "실시간 작업", mod: "team", props: info, focus: false });
      if (created?.space !== placement.spaceId || !created?.tab || created.tab === placement.tabId) throw new Error("작업 탭을 만들지 못했습니다.");
      if (closed || !space()) return null;
      const result = await invoke("tab.layout", { id: created.tab });
      if (result?.space !== placement.spaceId || result?.tab !== created.tab || !ownedRoot(result.layout)) throw new Error("새 작업 탭의 소유 정보가 일치하지 않습니다.");
      record = result;
    }
    state = host.shared(WORKSPACE_KEY);
    if (!explicit && !restore && (!state?.open || state.owner !== owner || state.runId !== current.id)) return null;
    if (state?.owner === owner && (state.dismissed || 0) > oldDismissed) return null;
    let prefs = preferences(current, state?.runId === current.id ? state : null);
    if (stageId) {
      const stage = current.stages.find((entry) => entry.id === stageId);
      if (!stage) throw new Error("표시할 역할을 찾지 못했습니다.");
      const slot = SLOTS.find((item) => selectStage(current, prefs.choices[item])?.agent === stage.agent) ?? "left";
      prefs = { ...prefs, choices: { ...prefs.choices, [slot]: "stage:" + stageId }, picker: null };
    }
    let live = host.terminals();
    const describe = () => JSON.stringify({ runId: current.id, tabId: record.tab, ...prefs, bindings: bindingsFor(current, live, prefs) });
    let signature = describe();
    const focusTab = async () => {
      await invoke("tab.select", { id: record.tab });
      if (stageId) {
        const terminal = bindingsFor(current, host.terminals(), prefs).find((binding) => binding.stageId === stageId)?.terminal;
        if (terminal) await invoke("pane.focus", { terminal });
      }
    };
    if (state?.owner === owner && state.runId === current.id && signature === fingerprint) {
      if (focus) await focusTab();
      return record.tab;
    }
    ensureUnmodifiedControls(record.layout, record.tab);
    if (state?.owner !== owner || state.runId !== current.id || state.tabId !== record.tab) generation++;
    else generation = state.generation;
    const session = { owner, generation, runId: current.id, spaceId: placement.spaceId,
      managerTabId: placement.tabId, tabId: record.tab, open: true,
      dismissed: state?.owner === owner ? state.dismissed || 0 : 0, revision: (state?.revision || 0) + 1, ...prefs };
    host.setShared(WORKSPACE_KEY, session);
    try {
      const context = { spaceId: placement.spaceId, managerTabId: placement.tabId, workspaceTabId: record.tab };
      for (let attempt = 0; attempt < 3; attempt++) {
        ensureUnmodifiedControls(record.layout, record.tab);
        const layout = workspaceLayout(current, live, prefs, owner, generation, context, record.layout);
        const requested = new Set(terminalAddresses(layout)), already = new Set(terminalAddresses(record.layout));
        const adopt = [];
        for (const terminal of live) {
          if (!requested.has(terminal.address) || already.has(terminal.address)) continue;
          const stage = current.stages.find((entry) => owned(terminal, current, entry));
          if (!stage) throw new Error("다른 작업의 터미널은 팀 작업 탭으로 옮길 수 없습니다.");
          adopt.push({ terminal: terminal.address, labels: {
            "aihub.run": current.id, "aihub.stage": stage.id, "aihub.attempt": String(stage.attempt),
          } });
        }
        try {
          await invoke("tab.layout", { id: record.tab, layout, expected: record.layout, adopt });
          break;
        } catch (error) {
          if (!layoutConflict(error) || attempt === 2) throw error;
          // A native terminal arrival can change the archive between the read
          // and write. Re-read this same tab and preserve every new terminal;
          // do not overwrite stale data or turn a retry into tab creation.
          if (closed || !space()) return null;
          let latest = host.shared(WORKSPACE_KEY);
          if (!latest?.open || latest.owner !== owner || latest.generation !== generation) return null;
          const refreshed = await readTab(record.tab);
          if (closed || !space()) return null;
          if (!refreshed) { dismissWorkspace(host, owner, generation); return null; }
          latest = host.shared(WORKSPACE_KEY);
          if (!latest?.open || latest.owner !== owner || latest.generation !== generation) return null;
          record = refreshed;
          prefs = preferences(current, latest);
          live = host.terminals();
          signature = describe();
        }
      }
      if (closed || !space()) return null;
      const latest = host.shared(WORKSPACE_KEY);
      if (!latest?.open || latest.owner !== owner || latest.generation !== generation) return null;
      fingerprint = signature;
      if (focus) await focusTab();
      return record.tab;
    } catch (error) {
      // Keep the existing native tab and its terminals intact. A later refresh
      // can read a fresh CAS snapshot; failed updates never close/recreate it.
      fingerprint = null;
      if (!space()?.tabs.some((tab) => tab.id === record.tab)) dismissWorkspace(host, owner, generation);
      throw error;
    }
  };
  return {
    open(current, options = {}) { return enqueue(() => show(copy(current), { explicit: true, focus: true, ...options })); },
    autoOpenToken() {
      const state = host.shared(WORKSPACE_KEY), active = host.spaces().find((item) => item.active);
      return { owner: state?.owner ?? null, dismissed: state?.dismissed || 0, activeSpace: active?.id ?? null };
    },
    autoOpen(current, token) {
      return enqueue(() => {
        const state = host.shared(WORKSPACE_KEY);
        if (closed || !space()) return null;
        if (state?.owner && state.owner === token?.owner && (state.dismissed || 0) > (token?.dismissed || 0)) return null;
        if (state?.owner === owner && (state.dismissed || 0) > (token?.owner === owner ? token.dismissed : 0)) return null;
        if (state?.owner && state.owner !== owner && state.owner !== token?.owner) return null;
        const active = host.spaces().find((item) => item.active);
        return show(copy(current), { explicit: true, focus: active?.id === placement.spaceId && token?.activeSpace === placement.spaceId });
      });
    },
    sync(current) {
      if (pendingSync) return pendingSync;
      pendingSync = enqueue(() => {
        const state = host.shared(WORKSPACE_KEY);
        const restore = firstSync && state?.runId === current?.id && state?.spaceId === placement?.spaceId;
        firstSync = false;
        return show(copy(current), { restore });
      }).finally(() => { pendingSync = null; });
      return pendingSync;
    },
    close() {
      closed = true;
      const state = host.shared(WORKSPACE_KEY);
      if (state?.owner === owner) dismissWorkspace(host, owner, state.generation);
      fingerprint = null;
    },
  };
}
