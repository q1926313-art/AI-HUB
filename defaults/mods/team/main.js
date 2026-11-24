// AI Hub (2026-11-24): a persistent team manager and live work tabs in one ordinary Space.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  theme, spaces, panes, terminals, props, checking, closeOverlay, nextCommand, pickFolder,
  shared, setShared, hc, exec, run, command, knownAgents, readTextFile, writeTextFile, appHome, home, window,
} from "herdr";
import { defaultProfiles, readState, activeStage, nextStage } from "./model.js";
import { createRuntime } from "./runtime.js";
import { modelOptions, effortOptions, effortProblem } from "./options.js";
import { createWorkspace } from "./workspace.js";
import WorkspaceView from "./workspace-view.js";

const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const MODEL_TOOLS = new Set(["claude", "codex", "opencode"]);
const MAX_ROLES = 8;
const MODEL_RESULTS = 60;
const STATUS = {
  draft: "시작 전", pending: "대기", launching: "시작 중", running: "실행 중",
  ready: "보고서 확인 필요", completed: "인수인계 완료", blocked: "확인 필요",
  error: "문제 발생", stopped: "중지됨", paused: "일시 정지",
};
const copy = (value) => JSON.parse(JSON.stringify(value));
const message = (error) => String(error?.message ?? error);
const busyStage = (stage) => ["launching", "running"].includes(stage?.status);
const dateLabel = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${two(date.getMonth() + 1)}.${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

// A remote space's cwd must never become a local launch folder by accident.
function localProject() {
  const space = spaces().find((entry) => entry.active);
  if (!space || space.machine) return { folder: "", spaceId: null, remote: Boolean(space?.machine) };
  const tabs = new Set(space.tabs.map((tab) => tab.id));
  const candidates = panes().filter((pane) => tabs.has(pane.tab));
  const pane = candidates.find((entry) => entry.focused && entry.cwd) ?? candidates.find((entry) => entry.cwd);
  return { folder: pane?.cwd || space.folder || "", spaceId: space.id, remote: false };
}

export default class Team extends View {
  init(_props, cx) {
    const entryProps = _props?.view === "workspace" || _props?.embedded === true ? _props : props() ?? {};
    if (entryProps?.view === "workspace") {
      this.workspaceView = new WorkspaceView();
      this.workspaceView.init(entryProps, cx);
      return;
    }
    this.isCheck = checking();
    const localId = (value) => typeof value === "string" && value.length > 0 && !value.includes("/");
    this.embedded = entryProps.embedded === true && [entryProps.space, entryProps.tab, entryProps.pane].every(localId);
    this.placement = this.embedded ? { spaceId: entryProps.space, tabId: entryProps.tab, paneId: entryProps.pane } : null;
    this.runtime = this.isCheck ? null : createRuntime({
      shared, setShared, hc, exec, run, knownAgents, readTextFile, writeTextFile, appHome, home, window,
      ...(this.placement ? { placement: { spaceId: this.placement.spaceId, tabId: this.placement.tabId } } : {}),
    });
    this.workspace = this.isCheck ? null : createWorkspace({ command, spaces, panes, terminals, shared, setShared, placement: this.placement });
    this.workspaceError = null;
    this.workspaceTask = null;
    this.workspaceSyncQueued = false;
    this.autoOpenWorkspace = true;
    this.state = this.runtime ? this.runtime.getState() : readState(null);
    this.screen = this.currentRun() ? "run" : "new";
    this.selectedStageId = null;
    this.error = null;
    this.notice = null;
    this.busy = null;
    this.refreshing = false;
    this.closed = false;
    this.armed = false;
    this.armedRunId = null;
    this.agents = [];
    this.agentsLoading = !this.isCheck;
    this.agentsError = null;
    this.agentPicker = null;
    this.modelPicker = null;
    this.modelCatalogs = {};
    this.profilesDirty = false;
    this.reportEditing = false;
    this.reportDirty = false;
    this.reportStageId = null;
    this.width = 960;
    this.newAuto = false;
    this.handle = cx.focus_handle();
    const project = this.isCheck ? { folder: "", spaceId: null, remote: false } : localProject();
    this.projectSpaceId = this.placement?.spaceId ?? project.spaceId;
    this.remoteProject = project.remote;
    this.titleInput = InputState.new({ placeholder: "예: 로그인 오류 수정" });
    this.goalInput = TextareaState.new({ placeholder: "무엇을 만들거나 고칠까요? 원하는 결과와 확인할 조건을 적어 주세요.", rows: 4 });
    this.folderInput = InputState.new({ value: project.folder, placeholder: "프로젝트 폴더의 전체 경로" });
    this.reportInput = TextareaState.new({ value: "", rows: 12 });
    for (const input of [this.titleInput, this.goalInput, this.folderInput]) {
      input.on("change", (_event, cx) => { this.error = null; this.notice = null; cx.notify(); });
    }
    this.reportInput.on("change", (_event, cx) => {
      this.reportDirty = this.reportInput.value() !== this.reportOriginal;
      this.error = null;
      cx.notify();
    });
    this.setProfileEditors(this.state.profiles);
    this.setReportEditor(this.selectedStage());
    // Native checks render these same controls without touching the host or starting loops.
    if (this.isCheck) return;
    this.handle.focus();
    this.loadAgents(cx);
    this.syncWorkspace();
    cx.timer.every(3000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        if (command === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  currentRun() {
    return this.state.runs.find((entry) => entry.id === this.state.selectedRunId) ?? null;
  }

  selectedStage() {
    const current = this.currentRun();
    return current?.stages.find((stage) => stage.id === this.selectedStageId)
      ?? (current ? activeStage(current) ?? current.stages[current.stages.length - 1] : null);
  }

  setProfileEditors(profiles) {
    for (const inputs of [this.profileInputs, this.profileNames, this.profileModels, this.modelSearchInputs]) {
      for (const input of Object.values(inputs ?? {})) input.release();
    }
    this.profileDraft = copy(profiles ?? defaultProfiles()).map((profile) => ({
      ...profile, model: profile.model ?? "", effort: profile.effort ?? "", access: profile.access ?? (profile.id === "implement" ? "write" : "read"),
    }));
    this.profileInputs = {};
    this.profileNames = {};
    this.profileModels = {};
    this.modelSearchInputs = {};
    for (const profile of this.profileDraft) this.createProfileEditors(profile);
    this.profileBaseline = JSON.stringify(this.collectProfiles());
    this.profilesDirty = false;
    this.agentPicker = null;
    this.modelPicker = null;
  }

  createProfileEditors(profile) {
    const id = profile.id;
    this.profileNames[id] = InputState.new({ value: profile.name, placeholder: "역할 이름" });
    this.profileModels[id] = InputState.new({ value: profile.model ?? "", placeholder: profile.agent === "opencode" ? "provider/model 전체 ID" : "비워 두면 도구의 기본 모델" });
    this.profileInputs[id] = TextareaState.new({ value: profile.instructions, rows: 3 });
    this.modelSearchInputs[id] = InputState.new({ placeholder: "모델 이름 또는 전체 ID 검색" });
    for (const input of [this.profileNames[id], this.profileModels[id], this.profileInputs[id]]) {
      input.on("change", (_event, cx) => { this.updateProfilesDirty(); this.notice = null; this.error = null; cx.notify(); });
    }
    this.modelSearchInputs[id].on("change", (_event, cx) => cx.notify());
  }

  collectProfiles() {
    return this.profileDraft.map((profile) => ({
      ...profile,
      name: this.profileNames[profile.id]?.value() ?? profile.name,
      model: this.profileModels[profile.id]?.value() ?? profile.model ?? "",
      effort: profile.effort ?? "",
      instructions: this.profileInputs[profile.id]?.value() ?? profile.instructions,
    }));
  }

  captureProfileEdits() {
    const values = this.collectProfiles();
    // Keep each role object and native text state alive when order changes.
    this.profileDraft.forEach((profile, index) => Object.assign(profile, values[index]));
  }

  updateProfilesDirty() {
    this.profilesDirty = JSON.stringify(this.collectProfiles()) !== this.profileBaseline;
  }

  addRole(cx) {
    if (this.busy || this.profileDraft.length >= MAX_ROLES) return;
    this.captureProfileEdits();
    let index = 1;
    while (this.profileDraft.some((profile) => profile.id === `role-${index}`)) index++;
    const profile = {
      id: `role-${index}`, name: "새 역할", agent: "codex", model: "", effort: "", access: "read", enabled: true,
      instructions: "프로젝트 지침과 작업 목표를 확인하고 맡은 역할을 수행하세요. 결과, 확인한 근거와 남은 문제를 인수인계 보고서에 정리하세요.",
    };
    this.profileDraft.push(profile);
    this.createProfileEditors(profile);
    this.updateProfilesDirty();
    this.notice = null;
    this.error = null;
    this.profileNames[profile.id].focus();
    cx.notify();
  }

  moveRole(id, direction, cx) {
    if (this.busy) return;
    const index = this.profileDraft.findIndex((profile) => profile.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.profileDraft.length) return;
    this.captureProfileEdits();
    [this.profileDraft[index], this.profileDraft[target]] = [this.profileDraft[target], this.profileDraft[index]];
    this.updateProfilesDirty();
    this.notice = null;
    cx.notify();
  }

  removeRole(id, cx) {
    if (this.busy || this.profileDraft.length <= 1) return;
    this.captureProfileEdits();
    this.profileDraft = this.profileDraft.filter((profile) => profile.id !== id);
    for (const inputs of [this.profileInputs, this.profileNames, this.profileModels, this.modelSearchInputs]) {
      inputs[id]?.release();
      delete inputs[id];
    }
    if (this.agentPicker === id) this.agentPicker = null;
    if (this.modelPicker === id) this.modelPicker = null;
    this.updateProfilesDirty();
    this.notice = "역할을 목록에서 제외했습니다. 저장 전에는 변경 취소로 되돌릴 수 있습니다.";
    cx.notify();
  }

  selectAgent(id, agent, cx) {
    if (this.busy) return;
    this.captureProfileEdits();
    const profile = this.profileDraft.find((entry) => entry.id === id);
    if (!profile) return;
    if (profile.agent !== agent) {
      profile.agent = agent;
      profile.model = "";
      this.profileModels[id].set_value("");
      this.modelSearchInputs[id].set_value("");
      this.notice = MODEL_TOOLS.has(agent) ? "담당 도구를 바꿨습니다. 모델과 추론 강도를 확인해 주세요." : "담당 도구를 바꿨습니다. 이 도구는 기본 모델로 실행됩니다. 이전 추론 강도도 확인해 주세요.";
    }
    this.agentPicker = null;
    this.modelPicker = null;
    this.updateProfilesDirty();
    cx.notify();
  }

  loadModels(profile, cx) {
    if (this.isCheck || this.closed || this.busy || !MODEL_TOOLS.has(profile.agent)) return;
    const agent = profile.agent;
    const folder = this.modelFolder();
    const cached = this.modelCatalogs[agent];
    const previous = agent === "opencode" && cached?.folder !== folder ? null : cached;
    if (previous?.loading) return;
    const request = { models: previous?.models ?? [], loaded: Boolean(previous?.loaded), loading: true, error: null, folder };
    this.modelCatalogs[agent] = request;
    this.modelPicker = profile.id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const models = await this.runtime.listModels({ agent, folder, refresh: Boolean(previous?.loaded) });
        if (this.closed || this.modelCatalogs[agent] !== request) return;
        const seen = new Set();
        request.models = models.filter((model) => typeof model?.id === "string" && model.id && !seen.has(model.id) && (seen.add(model.id) || true));
        request.loaded = true;
      } catch (error) { request.error = message(error); }
      request.loading = false;
      cx.notify();
    });
  }

  selectModel(profileId, modelId, cx, sourceAgent = null) {
    const profile = this.profileDraft.find((entry) => entry.id === profileId);
    if (this.busy || !profile || !MODEL_TOOLS.has(profile.agent) || (sourceAgent && profile.agent !== sourceAgent) || !this.profileModels[profileId]) return;
    this.profileModels[profileId].set_value(modelId);
    this.updateProfilesDirty();
    this.modelPicker = null;
    this.notice = "모델을 선택했습니다. 추론 강도를 확인하고 역할 설정을 저장하세요.";
    cx.notify();
  }

  modelCatalog(profile) {
    const catalog = this.modelCatalogs[profile.agent];
    // OpenCode providers and variants can change with the project's config.
    // Keep the person's input, but never validate it using another folder's catalog.
    if (catalog && (profile.agent !== "opencode" || catalog.folder === this.modelFolder())) return catalog;
    return {
      models: modelOptions(profile.agent).filter((model) => model.id),
      loading: false, loaded: profile.agent !== "opencode", error: null,
    };
  }

  modelFolder() {
    return this.folderInput.value().trim() || this.currentRun()?.folder || undefined;
  }

  modelCapability(profile) {
    const model = this.profileModels[profile.id]?.value().trim() ?? profile.model ?? "";
    return this.modelCatalog(profile).models.find((entry) => entry.id === model) ?? null;
  }

  profileEffortProblem(profile) {
    const model = this.profileModels[profile.id]?.value().trim() ?? profile.model ?? "";
    return effortProblem(profile.agent, model, profile.effort ?? "", this.modelCapability(profile));
  }

  selectEffort(profileId, effort, cx) {
    if (this.busy) return;
    const profile = this.profileDraft.find((entry) => entry.id === profileId);
    if (!profile) return;
    const model = this.profileModels[profile.id]?.value().trim() ?? profile.model ?? "";
    const problem = effortProblem(profile.agent, model, effort, this.modelCapability(profile));
    if (problem) { this.error = problem; cx.notify(); return; }
    profile.effort = effort;
    this.updateProfilesDirty();
    this.notice = "추론 강도를 적용하려면 역할 설정을 저장하세요.";
    this.error = null;
    cx.notify();
  }

  discardProfiles(cx) {
    if (this.busy) return;
    this.setProfileEditors(this.runtime ? this.runtime.getState().profiles : this.state.profiles);
    this.error = null;
    this.notice = "저장 전 역할 변경을 취소했습니다.";
    cx.notify();
  }

  allowNavigation(target, cx) {
    if (this.profilesDirty && target !== "profiles") {
      this.screen = "profiles";
      this.error = "역할 설정을 저장하거나 변경 취소 후 이동해 주세요.";
      cx?.notify();
      return false;
    }
    if (this.reportDirty && target !== "run") {
      this.screen = "run";
      this.error = "편집한 보고서를 저장하거나 편집 취소 후 이동해 주세요.";
      cx?.notify();
      return false;
    }
    return true;
  }

  setReportEditor(stage) {
    this.reportStageId = stage?.id ?? null;
    this.reportOriginal = stage?.report ? JSON.stringify(stage.report, null, 2) : "";
    if (this.reportInput.value() !== this.reportOriginal) this.reportInput.set_value(this.reportOriginal);
    this.reportDirty = false;
  }

  syncState() {
    if (this.runtime) this.state = this.runtime.getState();
    const stage = this.selectedStage();
    if (!this.reportDirty && !this.reportEditing) this.setReportEditor(stage);
    this.syncWorkspace();
  }

  syncWorkspace() {
    if (this.isCheck || this.closed || !this.workspace || !this.currentRun()) return;
    // Coalesce polling while a tab update is pending. Read the latest run when
    // the queued update begins, including a retry's new attempt/terminal.
    this.workspaceSyncQueued = true;
    if (this.workspaceTask) return this.workspaceTask;
    const sync = async () => {
      while (this.workspaceSyncQueued && !this.closed && !this.isCheck) {
        this.workspaceSyncQueued = false;
        const current = this.currentRun();
        if (!current) break;
        try { await this.workspace.sync(current); this.workspaceError = null; }
        catch (error) { this.workspaceError = message(error); }
      }
    };
    const task = sync();
    this.workspaceTask = task;
    task.then(() => { if (this.workspaceTask === task) this.workspaceTask = null; },
      (error) => { this.workspaceError = message(error); if (this.workspaceTask === task) this.workspaceTask = null; });
    return task;
  }

  openWorkspace(current, cx, options = {}) {
    if (this.isCheck || this.closed || !this.workspace || !current) return;
    cx.spawn(async (cx) => {
      try { await this.workspace.open(current, options); this.workspaceError = null; }
      catch (error) { this.workspaceError = message(error); }
      cx.notify();
    });
  }

  closeWorkspace() {
    if (this.isCheck || !this.workspace) return;
    try { this.workspace.close(); }
    catch (error) { this.workspaceError = message(error); }
  }

  workspaceAutoToken() {
    if (this.isCheck || this.closed || !this.workspace || !this.autoOpenWorkspace) return null;
    try { return this.workspace.autoOpenToken(); }
    catch (error) { this.workspaceError = message(error); return null; }
  }

  async showStartedWorkspace(cx, viewerToken) {
    this.syncState();
    if (this.isCheck || this.closed || !this.workspace || !viewerToken) return;
    const current = this.currentRun();
    const stage = current && activeStage(current);
    if (this.autoOpenWorkspace && stage?.terminal && ["running", "ready"].includes(stage.status)) {
      try { await this.workspace.autoOpen(current, viewerToken); this.workspaceError = null; }
      catch (error) { this.workspaceError = message(error); }
      cx?.notify();
    }
  }

  disarm() {
    this.armed = false;
    this.armedRunId = null;
  }

  stopAutomatic() {
    // Save the stop as well as clearing this view's latch: a pending host read
    // may finish after the person leaves the team window.
    if (!this.isCheck && this.runtime && this.armedRunId) {
      try {
        const current = this.runtime.getState().runs.find((entry) => entry.id === this.armedRunId);
        if (current?.autoAdvance && activeStage(current)) this.runtime.pause(current.id);
      } catch (error) { this.error = message(error); }
    }
    this.disarm();
  }

  close() {
    if (this.workspaceView) { this.workspaceView.close(); return; }
    this.closed = true;
    this.workspaceSyncQueued = false;
    this.stopAutomatic();
    this.closeWorkspace();
  }

  dismiss(cx) {
    if (this.embedded) {
      if (this.agentPicker || this.modelPicker) {
        this.agentPicker = null;
        this.modelPicker = null;
        cx.notify();
      } else if (this.screen !== "run" && this.currentRun()) this.navigate("run", cx);
      // Esc belongs to navigation in a normal tab. Closing its pane/Space
      // invokes close(), where future automatic handoffs are paused.
      return;
    }
    if (!this.allowNavigation(null, cx)) return;
    this.stopAutomatic();
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  navigate(screen, cx) {
    if (!this.allowNavigation(screen, cx)) return;
    this.screen = screen;
    this.notice = null;
    this.error = null;
    cx.notify();
  }

  loadAgents(cx) {
    if (this.isCheck || this.closed || (this.agentsLoading && this.agentRequest)) return;
    this.agentsLoading = true;
    this.agentRequest = true;
    this.agentsError = null;
    cx.spawn(async (cx) => {
      try { this.agents = await knownAgents({ on: null }); }
      catch (error) { this.agentsError = message(error); }
      this.agentsLoading = false;
      this.agentRequest = false;
      cx.notify();
    });
  }

  perform(cx, label, action) {
    if (this.isCheck || this.closed || this.busy) return;
    this.busy = label;
    this.error = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      // Click contexts end with their callback. Actions which await work must
      // receive this task's AsyncContext instead of retaining the click's cx.
      try { await action(cx); }
      catch (error) { this.error = message(error); this.disarm(); }
      finally {
        this.busy = null;
        this.syncState();
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.isCheck || this.closed) return;
    this.syncState();
    cx.notify();
    // A launch/retry can change attempt identity before its async CLI setup ends.
    // Keep the viewer current even while network/process refreshes are paused.
    if (this.busy || this.refreshing) return;
    const current = this.state.runs.find((entry) => entry.id === this.armedRunId) ?? this.currentRun();
    const stage = current && activeStage(current);
    if (!current || !["launching", "running", "ready"].includes(stage?.status)) return;
    this.refreshing = true;
    const id = current.id;
    const follow = !this.selectedStageId || this.selectedStageId === stage.id;
    cx.spawn(async (cx) => {
      try {
        await this.runtime.refresh(id, { autoAdvance: this.armed && this.armedRunId === id && !this.reportEditing && !this.reportDirty });
        this.syncState();
        if (follow && this.currentRun()?.id === id) {
          this.selectedStageId = activeStage(this.currentRun())?.id ?? null;
          if (!this.reportDirty && !this.reportEditing) this.setReportEditor(this.selectedStage());
        }
      } catch (error) { this.error = message(error); this.disarm(); }
      this.refreshing = false;
      cx.notify();
    });
  }

  pickProject(cx) {
    this.perform(cx, "폴더 선택 중…", async () => {
      const folder = await pickFolder({ prompt: "프로젝트 선택" });
      if (folder) {
        this.folderInput.set_value(folder);
        this.projectSpaceId = this.placement?.spaceId ?? null;
        this.remoteProject = false;
      }
    });
  }

  start(cx) {
    if (!this.allowNavigation("new", cx)) return;
    const input = {
      title: this.titleInput.value().trim(), goal: this.goalInput.value().trim(),
      folder: this.folderInput.value().trim(), spaceId: this.projectSpaceId,
      machine: null, autoAdvance: this.newAuto,
    };
    this.perform(cx, "첫 역할을 시작하는 중…", async (taskCx) => {
      const current = this.runtime.create(input);
      // Browsing New no longer pauses the existing run. Starting a different
      // run does: an in-flight automatic handoff must see that saved stop.
      this.stopAutomatic();
      this.runtime.select(current.id);
      this.runtime.setAuto(current.id, this.newAuto);
      this.screen = "run";
      this.selectedStageId = current.stages[0]?.id ?? null;
      this.reportEditing = false;
      this.reportDirty = false;
      this.armed = true;
      this.armedRunId = current.id;
      const viewerToken = this.workspaceAutoToken();
      await this.runtime.launch(current.id);
      await this.showStartedWorkspace(taskCx, viewerToken);
    });
  }

  openRun(id, cx) {
    if (this.isCheck || this.busy) return;
    if (!this.allowNavigation("run", cx)) return;
    if (this.reportDirty) {
      this.error = "편집한 보고서를 저장하거나 편집 취소 후 다른 기록을 열어 주세요.";
      cx.notify();
      return;
    }
    this.stopAutomatic();
    this.runtime.select(id);
    this.screen = "run";
    this.selectedStageId = null;
    this.reportEditing = false;
    this.reportDirty = false;
    this.error = null;
    this.notice = null;
    this.syncState();
    cx.notify();
  }

  chooseStage(stage, cx) {
    if (this.reportDirty && stage.id !== this.reportStageId) {
      this.error = "편집한 보고서를 저장하거나 편집 취소 후 다른 단계를 열어 주세요.";
      cx.notify();
      return;
    }
    this.selectedStageId = stage.id;
    this.reportEditing = false;
    this.setReportEditor(stage);
    cx.notify();
  }

  launch(current, cx) {
    this.perform(cx, "역할을 시작하는 중…", async (taskCx) => {
      this.armed = true;
      this.armedRunId = current.id;
      this.selectedStageId = activeStage(current)?.id ?? null;
      this.reportEditing = false;
      this.reportDirty = false;
      const viewerToken = this.workspaceAutoToken();
      await this.runtime.launch(current.id);
      await this.showStartedWorkspace(taskCx, viewerToken);
    });
  }

  advance(current, cx) {
    this.perform(cx, "인수인계를 연결하는 중…", async (taskCx) => {
      this.armed = true;
      this.armedRunId = current.id;
      const viewerToken = this.workspaceAutoToken();
      await this.runtime.advance(current.id);
      this.selectedStageId = null;
      this.reportEditing = false;
      this.reportDirty = false;
      await this.showStartedWorkspace(taskCx, viewerToken);
    });
  }

  pause(current, cx) {
    if (this.isCheck || this.busy) return;
    this.disarm();
    try {
      this.runtime.pause(current.id);
      this.notice = "자동 진행을 멈췄습니다. 현재 실행 중인 AI는 계속 작업합니다.";
      this.syncState();
    } catch (error) { this.error = message(error); }
    cx.notify();
  }

  interrupt(current, cx) {
    this.disarm();
    this.perform(cx, "중지 요청 중…", async () => {
      await this.runtime.interrupt(current.id);
      this.notice = "현재 AI에 중지를 요청했습니다. 실제 상태는 해당 터미널에서 확인할 수 있습니다.";
    });
  }

  saveProfiles(cx) {
    const profiles = this.collectProfiles();
    const invalid = this.profileDraft.find((profile) => this.profileEffortProblem(profile));
    if (invalid) { this.error = this.profileEffortProblem(invalid); cx.notify(); return; }
    this.perform(cx, "역할 설정 저장 중…", () => {
      const saved = this.runtime.saveProfiles(profiles);
      this.setProfileEditors(saved);
      this.notice = "역할 설정을 저장했습니다. 새로 시작하는 팀 작업에 적용됩니다.";
    });
  }

  saveReport(current, cx) {
    const text = this.reportInput.value();
    this.perform(cx, "보고서 저장 중…", async () => {
      await this.runtime.saveReport(current.id, text);
      this.reportDirty = false;
      this.reportEditing = false;
      this.notice = "검토한 보고서를 저장했습니다. 다음 역할에 이 내용이 전달됩니다.";
    });
  }

  toggleAuto(current, cx) {
    if (this.isCheck || this.busy) return;
    try { this.runtime.setAuto(current.id, !current.autoAdvance); this.syncState(); }
    catch (error) { this.error = message(error); }
    cx.notify();
  }

  toolName(key) {
    return this.agents.find((agent) => agent.key === key)?.name ?? TOOL_NAMES[key] ?? key;
  }

  assignee(profile) {
    return `${this.toolName(profile.agent)} · ${profile.model || "도구 기본 모델"} · 추론 ${this.effortName(profile)}`;
  }

  effortName(profile) {
    const effort = profile?.effort ?? "";
    return effortOptions(profile?.agent, profile?.model ?? "").find((option) => option.id === effort)?.label
      ?? (effort || "도구 기본값");
  }

  accessName(access) {
    return access === "write" ? "구현·수정" : "자문·검토";
  }

  toolHint(key) {
    const agent = this.agents.find((entry) => entry.key === key);
    return this.agentsLoading ? "확인 중" : agent ? agent.installed ? "사용 가능" : "설치 필요" : "설치 확인 전";
  }

  statusColor(t, value) {
    return value === "running" || value === "launching" ? t.working
      : value === "ready" || value === "blocked" || value === "error" ? t.blocked
      : value === "completed" ? t.accent : t.dim;
  }

  badge(t, value, label = null) {
    const color = this.statusColor(t, value);
    return div().flex_none().px(8).py(3).rounded(5).bg(color + "18").text_color(color).text_size(11)
      .child(label ?? STATUS[value] ?? value ?? "대기");
  }

  button(t, id, label, action, options = {}) {
    const enabled = !options.disabled && !this.busy;
    return h_flex().id(id).flex_none().h(options.small ? 28 : 34).px(options.small ? 9 : 12).gap(6).items_center().justify_center().rounded(7)
      .border_1().border_color(options.primary && enabled ? t.accent : t.border)
      .bg(options.primary && enabled ? t.accent : t.raised)
      .text_color(!enabled ? t.dim : options.primary ? t.accent_foreground : options.danger ? t.blocked : t.foreground).text_size(options.small ? 11.5 : 12)
      .when(enabled, (element) => element.cursor_pointer().hover((style) => style.bg(options.primary ? t.accent : t.hover)))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => { cx.stop_propagation(); if (enabled) action(cx); })
      .child(label);
  }

  label(t, text, hint = null) {
    return h_flex().gap(8).items_center().mb(6)
      .child(div().text_size(12).font_medium().text_color(t.foreground).child(text))
      .when(Boolean(hint), (element) => element.child(div().text_size(11).text_color(t.dim).child(hint)));
  }

  field(t, element) {
    return element.w_full().min_w(0).px(11).py(9).rounded(7).border_1().border_color(t.input ?? t.border)
      .bg(t.background).text_size(13).text_color(t.foreground);
  }

  toggle(t, id, checked, title, action, detail = null) {
    return h_flex().id(id).items_start().gap(9).cursor_pointer()
      .on_click((_event, cx) => { if (!this.busy) action(cx); })
      .child(div().flex_none().size(16).mt(1).rounded(4).border_1().border_color(checked ? t.accent : t.input ?? t.border)
        .bg(checked ? t.accent : t.background).text_color(t.accent_foreground).text_size(12).flex().items_center().justify_center().child(checked ? "✓" : ""))
      .child(v_flex().flex_1().min_w(0).gap(3).child(div().text_size(12).text_color(t.foreground).child(title))
        .when(Boolean(detail), (element) => element.child(div().text_size(11).text_color(t.dim).child(detail))));
  }

  newView(t) {
    const profiles = this.state.profiles.filter((profile) => profile.enabled !== false);
    const valid = this.titleInput.value().trim() && this.goalInput.value().trim() && this.folderInput.value().trim() && profiles.length;
    return v_flex().id("team-new-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(22).gap(17)
      .child(v_flex().gap(5).child(div().text_size(20).font_semibold().text_color(t.foreground).child("어떤 일을 함께 할까요?"))
        .child(div().text_size(12).text_color(t.muted).child("목표를 정하면 역할별 AI가 순서대로 작업하고, 보고서로 다음 역할에 인수인계합니다.")))
      .child(v_flex().child(this.label(t, "작업 제목")).child(this.field(t, Input.new(this.titleInput)).h(38)))
      .child(v_flex().child(this.label(t, "목표와 완료 조건")).child(this.field(t, Textarea.new(this.goalInput)).h(112)))
      .child(v_flex().child(this.label(t, "로컬 프로젝트 폴더"))
        .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).child(this.field(t, Input.new(this.folderInput)).h(38)))
          .child(this.button(t, "team-pick-folder", "폴더 선택", (cx) => this.pickProject(cx))))
        .when(this.remoteProject, (element) => element.child(div().pt(6).text_size(11).text_color(t.blocked).child("현재 공간은 원격입니다. 이 작업에 사용할 로컬 프로젝트 폴더를 선택해 주세요."))))
      .child(v_flex().gap(9)
        .child(h_flex().items_center().justify_between().child(this.label(t, "역할 · 모델 · 추론 강도"))
          .child(this.button(t, "team-edit-roles", "모델·추론 설정", (cx) => this.navigate("profiles", cx), { small: true })))
        .children(profiles.map((profile, index) => h_flex().px(12).py(9).gap(10).items_center().rounded(7).bg(t.raised)
          .child(div().size(23).flex_none().rounded(6).bg(t.background).text_color(t.accent).text_size(11).flex().items_center().justify_center().child(String(index + 1)))
          .child(v_flex().flex_1().min_w(0).gap(4)
            .child(div().text_size(12).text_color(t.foreground).child(profile.name))
            .child(div().text_size(10.5).text_color(t.dim).child(this.accessName(profile.access))))
          .child(v_flex().flex_1().min_w(0).gap(4)
            .child(div().text_size(12).text_color(t.muted).child(this.toolName(profile.agent)))
            .child(div().id(`team-summary-model-${profile.id}`).truncate().tooltip(profile.model || "도구 기본 모델").text_size(10.5).text_color(t.dim).child(profile.model || "도구 기본 모델"))
            .child(div().id(`team-summary-effort-${profile.id}`).text_size(10.5).text_color(t.muted).child(`추론 강도: ${this.effortName(profile)}`)))
          .child(div().w(70).text_right().text_size(10.5).text_color(this.toolHint(profile.agent) === "설치 필요" ? t.blocked : t.dim).child(this.toolHint(profile.agent))))))
      .child(this.toggle(t, "team-new-auto", this.newAuto, "보고서가 준비되면 다음 역할 자동 실행", (cx) => { this.newAuto = !this.newAuto; cx.notify(); },
        "기본은 직접 확인 후 진행입니다. 자동 실행 중에도 보고서에 차단 이슈가 있으면 멈춥니다."))
      .child(this.toggle(t, "team-new-workspace", this.autoOpenWorkspace, "시작하면 실시간 작업 탭으로 이동", (cx) => { this.autoOpenWorkspace = !this.autoOpenWorkspace; cx.notify(); },
        "같은 AI 팀 Space에서 Claude는 왼쪽, Codex와 OpenCode는 오른쪽 위·아래에 표시합니다."))
      .child(h_flex().gap(12).items_center()
        .child(this.button(t, "team-start", "AI 팀 시작", (cx) => this.start(cx), { primary: true, disabled: !valid }))
        .child(div().flex_1().text_size(11).text_color(t.dim).child("팀 기록은 프로젝트의 .ai-hub/team에 저장됩니다.")));
  }

  agentChoices(profile, t) {
    const choices = this.agents.length ? this.agents : Object.entries(TOOL_NAMES).map(([key, name]) => ({ key, name, installed: null }));
    return v_flex().id(`team-tools-${profile.id}`).h(Math.min(200, choices.length * 32 + 8)).min_h(0).overflow_y_scrollbar().p(4).gap(2).rounded(7).border_1().border_color(t.border).bg(t.background)
      .children(choices.map((agent) => h_flex().id(`team-tool-${profile.id}-${agent.key}`).h(30).flex_none().px(9).gap(10).rounded(5).items_center().cursor_pointer()
        .bg(agent.key === profile.agent ? t.selected : t.background).hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => this.selectAgent(profile.id, agent.key, cx))
        .child(div().w(14).text_color(t.accent).child(agent.key === profile.agent ? "✓" : ""))
        .child(div().flex_1().text_size(12).text_color(t.foreground).child(agent.name))
        .child(div().text_size(10.5).text_color(agent.installed === false ? t.blocked : t.dim).child(agent.installed === null ? "설치 확인 전" : agent.installed ? "사용 가능" : "설치 필요"))));
  }

  modelChoices(profile, t) {
    const sourceAgent = profile.agent;
    const catalog = this.modelCatalog(profile);
    const query = this.modelSearchInputs[profile.id].value().trim().toLowerCase();
    const matches = catalog.models.filter((model) => !query || `${model.name ?? ""} ${model.id}`.toLowerCase().includes(query));
    const shown = matches.slice(0, MODEL_RESULTS);
    const selected = this.profileModels[profile.id].value().trim();
    return v_flex().p(10).gap(8).rounded(7).border_1().border_color(t.border).bg(t.background)
      .child(this.button(t, `team-model-default-${profile.id}`, "도구 기본 모델 사용", (cx) => this.selectModel(profile.id, "", cx, sourceAgent), { small: true, primary: !selected }))
      .child(this.field(t, Input.new(this.modelSearchInputs[profile.id])).h(36))
      .child(div().text_size(10.5).text_color(t.dim).child(`${matches.length}개 검색 결과 · 전체 ${catalog.models.length}개${matches.length > MODEL_RESULTS ? ` · 처음 ${MODEL_RESULTS}개 표시, 검색어로 좁혀 주세요` : ""}`))
      .when(Boolean(catalog.error), (element) => element.child(div().text_size(11).text_color(t.blocked).child(catalog.error)))
      .when(!shown.length, (element) => element.child(div().py(8).text_size(12).text_color(t.muted).child(catalog.loading ? "모델 목록을 확인하고 있습니다…" : query ? "일치하는 모델이 없습니다. 다른 검색어나 정확한 ID를 입력하세요." : "조회된 모델이 없습니다. 모델 목록을 불러오거나 정확한 ID를 직접 입력하세요.")))
      .when(Boolean(shown.length), (element) => element.child(v_flex().id(`team-model-list-${profile.id}`).h(Math.min(276, shown.length * 47 + 4)).min_h(0).overflow_y_scrollbar().gap(3)
        .children(shown.map((model, index) => h_flex().id(`team-model-option-${profile.id}-${index}`).h(44).flex_none().px(9).gap(8).items_center().rounded(5)
          .bg(model.id === selected ? t.selected : t.background).hover((style) => style.bg(t.hover)).cursor_pointer()
          .on_click((_event, cx) => this.selectModel(profile.id, model.id, cx, sourceAgent))
          .child(div().flex_none().w(14).text_color(t.accent).child(model.id === selected ? "✓" : ""))
          .child(v_flex().flex_1().min_w(0).gap(3)
            .child(div().text_size(12).text_color(t.foreground).child(model.name || model.id))
            .child(div().id(`team-model-id-${profile.id}-${index}`).truncate().tooltip(model.id).text_size(10.5).text_color(t.dim).child(model.id)))))));
  }

  effortChoices(profile, t) {
    const model = this.profileModels[profile.id]?.value().trim() ?? profile.model ?? "";
    const capability = this.modelCapability(profile);
    const options = effortOptions(profile.agent, model, capability);
    const problem = this.profileEffortProblem(profile);
    return v_flex().id(`team-effort-${profile.id}`).gap(7)
      .child(this.label(t, "추론 강도", "도구 기본값은 CLI 설정을 따름"))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .children(options.map((option) => this.button(t, `team-effort-${profile.id}-${option.id || "default"}`, option.label ?? option.name ?? option.id,
          (cx) => this.selectEffort(profile.id, option.id, cx), { small: true, primary: (profile.effort ?? "") === option.id }))))
      .when(Boolean(problem), (element) => element.child(div().text_size(11).text_color(t.blocked).child(`${problem} 현재 값: ${profile.effort || "도구 기본값"}`)))
      .when(Boolean(capability?.capabilityError), (element) => element.child(div().text_size(11).text_color(t.blocked).child(`추론 지원 정보 확인 실패: ${capability.capabilityError}`)))
      .child(div().text_size(10.5).text_color(t.dim).child(profile.agent === "opencode"
        ? "선택한 모델의 추론 설정을 사용합니다. 모델 목록에서 지원 항목을 확인할 수 있습니다."
        : profile.agent === "codex" ? "로컬 모델 목록을 확인하면 해당 모델이 지원하는 추론 강도를 선택할 수 있습니다."
          : profile.agent === "claude" ? "정확한 모델 ID를 선택하면 지원하는 추론 강도가 표시됩니다. 별칭은 도구 기본값을 사용합니다."
            : "이 도구는 기본 추론 설정으로 실행됩니다."));
  }

  profileView(profile, index, t) {
    const supported = MODEL_TOOLS.has(profile.agent);
    const catalog = this.modelCatalog(profile);
    const currentModel = this.profileModels[profile.id].value();
    return v_flex().id(`team-profile-${profile.id}`).p(14).gap(12).rounded(9).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().gap(9).items_center()
        .child(div().size(25).flex_none().rounded(6).bg(t.background).text_color(t.accent).text_size(11).flex().items_center().justify_center().child(String(index + 1)))
        .child(div().flex_1().min_w(0).child(this.field(t, Input.new(this.profileNames[profile.id])).h(36)))
        .child(this.button(t, `team-profile-toggle-${profile.id}`, profile.enabled !== false ? "사용 중" : "제외됨", (cx) => {
          profile.enabled = profile.enabled === false; this.updateProfilesDirty(); this.notice = null; cx.notify();
        }, { small: true })))
      .child(h_flex().gap(6).items_center()
        .child(this.button(t, `team-role-up-${profile.id}`, "↑ 위로", (cx) => this.moveRole(profile.id, -1, cx), { small: true, disabled: index === 0 }))
        .child(this.button(t, `team-role-down-${profile.id}`, "↓ 아래로", (cx) => this.moveRole(profile.id, 1, cx), { small: true, disabled: index === this.profileDraft.length - 1 }))
        .child(div().flex_1())
        .child(this.button(t, `team-role-remove-${profile.id}`, "역할 삭제", (cx) => this.removeRole(profile.id, cx), { small: true, danger: true, disabled: this.profileDraft.length <= 1 })))
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(11).text_color(t.muted).child("담당 도구"))
        .child(this.button(t, `team-profile-agent-${profile.id}`, `${this.toolName(profile.agent)}  ▾`, (cx) => {
          this.agentPicker = this.agentPicker === profile.id ? null : profile.id; this.modelPicker = null; cx.notify();
        }, { small: true }))
        .child(div().text_size(10.5).text_color(this.toolHint(profile.agent) === "설치 필요" ? t.blocked : t.dim).child(this.toolHint(profile.agent))))
      .when(this.agentPicker === profile.id, (element) => element.child(this.agentChoices(profile, t)))
      .child(v_flex().gap(7)
        .child(this.label(t, "담당 모델", supported ? "빈 값은 도구의 기본 모델" : "이 도구는 기본 모델 사용"))
        .when(supported, (element) => element.child(this.field(t, Input.new(this.profileModels[profile.id])).h(36)))
        .when(!supported, (element) => element.child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(12).text_color(t.muted).child("도구 기본 모델"))
          .when(Boolean(currentModel), (row) => row.child(this.button(t, `team-model-clear-${profile.id}`, "이전 모델 지정 지우기", (cx) => {
            this.profileModels[profile.id].set_value(""); this.updateProfilesDirty(); cx.notify();
          }, { small: true })))))
        .when(supported, (element) => element
          .child(h_flex().gap(8).items_center().flex_wrap()
            .when(profile.agent === "opencode", (row) => row.child(this.button(t, `team-model-load-${profile.id}`, catalog.loading ? "모델 목록 확인 중…" : catalog.loaded ? "모델 목록 다시 불러오기" : "모델 목록 불러오기", (cx) => this.loadModels(profile, cx), { small: true, disabled: Boolean(catalog.loading) })))
            .when(profile.agent === "codex", (row) => row.child(this.button(t, `team-model-load-${profile.id}`, catalog.loading ? "로컬 모델 목록 확인 중…" : this.modelCatalogs.codex?.loaded ? "로컬 모델 목록 다시 확인" : "로컬 모델 목록 확인", (cx) => this.loadModels(profile, cx), { small: true, disabled: Boolean(catalog.loading) })))
            .when(Boolean(catalog?.loaded), (row) => row.child(this.button(t, `team-model-toggle-${profile.id}`, this.modelPicker === profile.id ? "목록 닫기" : "목록 보기", (cx) => {
              this.modelPicker = this.modelPicker === profile.id ? null : profile.id; this.agentPicker = null; cx.notify();
            }, { small: true }))))
          .child(div().text_size(10.5).text_color(t.dim).child(profile.agent === "opencode"
            ? "OpenCode에 표시되는 provider/model 전체 ID를 그대로 사용합니다."
            : profile.agent === "codex" ? "로컬 캐시가 없으면 공식 프리셋을 표시합니다. 정확한 모델 ID도 직접 입력할 수 있습니다."
              : "공식 모델 프리셋입니다. 계정·CLI 버전의 지원 여부를 확인하거나 정확한 모델 ID를 직접 입력하세요."))
          .when(this.modelPicker === profile.id, (row) => row.child(this.modelChoices(profile, t)))))
      .child(this.effortChoices(profile, t))
      .child(v_flex().gap(5)
        .child(this.label(t, "작업 방식"))
        .child(h_flex().gap(7).items_center()
          .children([["read", "자문·검토"], ["write", "구현·수정"]].map(([access, label]) => this.button(t, `team-access-${profile.id}-${access}`, label, (cx) => {
            profile.access = access; this.updateProfilesDirty(); this.notice = null; cx.notify();
          }, { small: true, primary: profile.access === access })))))
      .child(v_flex().child(this.label(t, "역할 지침")).child(this.field(t, Textarea.new(this.profileInputs[profile.id])).h(100)));
  }

  profilesView(t) {
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("team-profiles-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(22).gap(14)
        .child(v_flex().gap(5).child(div().text_size(19).font_semibold().text_color(t.foreground).child("역할별 도구와 지침"))
          .child(div().text_size(12).text_color(t.muted).child("1~8개의 역할을 원하는 이름과 순서로 구성하세요. 저장한 설정은 새 작업에 적용됩니다."))
          .child(div().text_size(11).text_color(t.dim).child("모델과 추론 강도를 역할마다 선택하세요. 작업 방식은 AI에게 전달하는 지침이며 운영체제 권한을 바꾸지 않습니다.")))
        .child(h_flex().gap(10).items_center()
          .child(this.button(t, "team-agent-refresh", this.agentsLoading ? "도구 확인 중…" : "설치된 도구 다시 확인", (cx) => this.loadAgents(cx), { small: true, disabled: this.agentsLoading }))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child(`${this.profileDraft.length}/${MAX_ROLES}개 역할`))
          .child(this.button(t, "team-role-add", "+ 역할 추가", (cx) => this.addRole(cx), { small: true, disabled: this.profileDraft.length >= MAX_ROLES })))
        .child(v_flex()
          .when(Boolean(this.agentsError), (element) => element.child(div().flex_1().text_size(11).text_color(t.blocked).child(`도구 확인 실패: ${this.agentsError}`))))
        .children(this.profileDraft.map((profile, index) => this.profileView(profile, index, t))))
      .child(h_flex().flex_none().px(22).py(13).gap(10).items_center().border_t(1).border_color(t.border)
        .child(this.button(t, "team-profile-defaults", "기본 역할 불러오기", (cx) => {
          const baseline = this.profileBaseline;
          this.setProfileEditors(defaultProfiles()); this.profileBaseline = baseline; this.updateProfilesDirty(); this.notice = null; cx.notify();
        }, { disabled: this.profilesDirty }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.profilesDirty ? "저장하지 않은 변경사항" : "저장된 역할 설정"))
        .when(this.profilesDirty, (element) => element.child(this.button(t, "team-profile-discard", "변경 취소", (cx) => this.discardProfiles(cx))))
        .child(this.button(t, "team-profile-save", "역할 저장", (cx) => this.saveProfiles(cx), { primary: true, disabled: !this.profilesDirty || this.profileDraft.some((profile) => this.profileEffortProblem(profile)) })));
  }

  stepsView(current, selected, t, compact) {
    return v_flex().when(!compact, (element) => element.w(232).flex_none()).gap(8)
      .child(div().mb(3).text_size(11).font_medium().text_color(t.dim).child("역할 진행 순서"))
      .children(current.stages.map((stage, index) => v_flex().id(`team-stage-${stage.id}`).p(12).gap(8).rounded(8)
        .border_1().border_color(stage.id === selected?.id ? t.accent : t.border).bg(stage.id === selected?.id ? t.selected : t.raised).cursor_pointer()
        .on_click((_event, cx) => this.chooseStage(stage, cx))
        .child(h_flex().gap(8).items_center()
          .child(div().size(22).rounded(5).bg(t.background).text_color(this.statusColor(t, stage.status)).text_size(11).flex().items_center().justify_center().child(String(index + 1)))
          .child(div().flex_1().min_w(0).text_size(12).font_medium().text_color(t.foreground).child(stage.roleName)))
        .child(h_flex().gap(7).items_center().child(div().flex_1().text_size(11).text_color(t.muted).child(this.toolName(stage.agent)))
          .child(this.badge(t, stage.status)))
        .child(div().id(`team-stage-model-${stage.id}`).min_w(0).truncate().tooltip(stage.model || "도구 기본 모델").text_size(10.5).text_color(t.dim).child(stage.model || "도구 기본 모델"))
        .child(div().id(`team-stage-effort-${stage.id}`).text_size(10.5).text_color(t.muted).child(`추론 강도: ${this.effortName(stage)}`))
        .child(div().text_size(10.5).text_color(t.dim).child(this.accessName(stage.access)))
        .when(Boolean(stage.terminal), (element) => element.child(this.button(t, `team-terminal-${stage.id}`, "작업 탭에서 보기",
          (cx) => this.openWorkspace(current, cx, { stageId: stage.id }), { small: true })))));
  }

  reportSection(t, title, body) {
    return v_flex().gap(6).child(div().text_size(11).font_semibold().text_color(t.muted).child(title)).child(body);
  }

  reportView(current, stage, t) {
    const report = stage?.report;
    const active = activeStage(current);
    const editable = Boolean(report && stage.id === active?.id && ["running", "ready"].includes(stage.status));
    const line = (text) => div().text_size(12).text_color(t.foreground).child(text);
    const list = (items, empty) => v_flex().gap(5).children((items?.length ? items : [empty]).map((item) => line(`${items?.length ? "• " : ""}${item}`)));
    return v_flex().flex_1().min_w(0).gap(14)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().text_size(16).font_semibold().text_color(t.foreground).child(stage?.roleName ?? "팀 작업"))
        .when(Boolean(stage), (element) => element.child(this.badge(t, stage.status))))
      .when(Boolean(stage), (element) => element.child(div().text_size(11).text_color(t.muted).child(`${this.assignee(stage)} · ${this.accessName(stage.access)}`)))
      .when(Boolean(stage?.error), (element) => element.child(div().p(12).rounded(7).bg(t.blocked + "12").text_color(t.blocked).text_size(12).child(stage.error)))
      .when(Boolean(stage?.reportError), (element) => element.child(div().p(12).rounded(7).bg(t.raised).text_color(t.blocked).text_size(12).child(stage.reportError)))
      .when(["blocked", "error"].includes(stage?.terminalState), (element) => element.child(div().text_size(12).text_color(t.blocked).child("담당 AI가 입력이나 확인을 기다리고 있습니다. 해당 터미널을 열어 확인해 주세요.")))
      .when(!report, (element) => element.child(v_flex().p(18).gap(9).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .child(div().text_size(13).font_medium().text_color(t.foreground).child(busyStage(stage) ? "담당 AI가 작업 중입니다" : stage?.status === "pending" ? "아직 시작하지 않은 역할입니다" : "인수인계 보고서가 아직 없습니다"))
        .child(div().text_size(12).text_color(t.muted).child(busyStage(stage)
          ? "작업 내용을 터미널에서 확인할 수 있습니다. 보고서가 도착하면 이곳에 표시합니다."
          : "이전 단계의 인수인계를 확인한 뒤 순서대로 실행합니다."))))
      .when(Boolean(report), (element) => element
        .child(div().text_size(11).text_color(report.status === "blocked" ? t.blocked : t.dim)
          .child(report.status === "blocked" ? "담당 AI가 진행을 막는 문제를 보고했습니다." : "아래 내용은 담당 AI가 제출한 보고서입니다. 테스트 근거와 남은 문제를 확인해 주세요."))
        .child(this.reportSection(t, "작업 요약", line(report.summary)))
        .child(this.reportSection(t, "변경한 내용", list(report.changes, "보고된 변경사항이 없습니다.")))
        .child(this.reportSection(t, "검증 기록", v_flex().gap(7)
          .when(!report.tests?.length, (body) => body.child(div().text_size(12).text_color(t.muted).child("보고된 테스트가 없습니다.")))
          .children((report.tests ?? []).map((test) => v_flex().p(10).gap(5).rounded(6).bg(t.background).border_1().border_color(t.border)
            .child(h_flex().gap(8).items_center().child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).child(test.command))
              .child(this.badge(t, test.result === "fail" ? "error" : test.result === "pass" ? "completed" : "pending", test.result === "pass" ? "통과 보고" : test.result === "fail" ? "실패 보고" : "미실행")))
            .when(Boolean(test.detail), (body) => body.child(div().text_size(11).text_color(t.muted).child(test.detail)))))))
        .child(this.reportSection(t, "남은 문제", list(report.issues, "보고된 문제가 없습니다.")))
        .child(this.reportSection(t, "다음 역할에 전달할 내용", line(report.next || "추가 전달사항이 없습니다.")))
        .when(editable, (body) => body.child(h_flex().gap(8)
          .child(this.button(t, "team-report-edit", this.reportEditing ? "편집 접기" : "보고서 원문 편집", (cx) => {
            if (!this.reportEditing) this.stopAutomatic();
            if (!this.reportEditing && !this.reportDirty) this.setReportEditor(stage);
            this.reportEditing = !this.reportEditing;
            cx.notify();
          }, { small: true }))
          .when(this.reportDirty, (row) => row.child(div().text_size(11).text_color(t.blocked).child("저장되지 않은 보고서"))))))
      .when(this.reportEditing && editable, (element) => element.child(v_flex().gap(8)
        .child(div().text_size(11).text_color(t.dim).child("JSON 형식을 유지해 수정하세요. 작업·단계 식별자와 시도 번호는 그대로 두세요."))
        .child(this.field(t, Textarea.new(this.reportInput)).h(260))
        .child(h_flex().gap(8)
          .child(this.button(t, "team-report-save", "편집한 보고서 저장", (cx) => this.saveReport(current, cx), { primary: true, disabled: !this.reportDirty }))
          .child(this.button(t, "team-report-cancel", "편집 취소", (cx) => { this.reportEditing = false; this.setReportEditor(stage); cx.notify(); })))));
  }

  runControls(current, t) {
    const stage = activeStage(current);
    const ready = stage?.status === "ready" && stage?.report?.status === "completed";
    const reviewingCurrent = this.selectedStage()?.id === stage?.id;
    const last = stage && current.stages.indexOf(stage) === current.stages.length - 1;
    const launchable = stage && ["pending", "error", "stopped"].includes(stage.status) && Boolean(nextStage(current));
    return v_flex().flex_none().px(22).py(13).gap(10).border_t(1).border_color(t.border)
      .when(Boolean(stage), (element) => element.child(this.toggle(t, "team-run-auto", Boolean(current.autoAdvance), "보고서가 준비되면 다음 역할 자동 실행", (cx) => this.toggleAuto(current, cx),
        current.autoAdvance && !(this.armed && this.armedRunId === current.id) ? "기록을 다시 열어도 자동 실행하지 않습니다. 다음 단계를 직접 시작하면 이어집니다." : null)))
      .child(h_flex().gap(8).items_center().flex_wrap()
        .when(ready, (element) => element.child(this.button(t, "team-advance", last ? "인수인계 확인 · 팀 작업 마치기" : "인수인계 확인 · 다음 단계 실행", (cx) => this.advance(current, cx),
          { primary: true, disabled: !reviewingCurrent || this.reportDirty || this.reportEditing || this.refreshing })))
        .when(ready && !reviewingCurrent, (element) => element.child(this.button(t, "team-show-current-report", "현재 보고서 보기", (cx) => this.chooseStage(stage, cx))))
        .when(launchable, (element) => element.child(this.button(t, "team-launch-stage", stage.status === "pending" ? "단계 실행" : "이 단계 다시 실행", (cx) => this.launch(current, cx), { primary: true, disabled: this.refreshing })))
        .when(Boolean(stage), (element) => element.child(this.button(t, "team-collect", "보고서 다시 읽기", (cx) => this.perform(cx, "보고서 확인 중…", () => this.runtime.collect(current.id)),
          { disabled: this.reportDirty || this.reportEditing || this.refreshing })))
        .when(Boolean(stage) && current.autoAdvance, (element) => element.child(this.button(t, "team-pause", "자동 진행 멈추기", (cx) => this.pause(current, cx))))
        .when(busyStage(stage), (element) => element.child(this.button(t, "team-interrupt", "현재 AI 중지 요청", (cx) => this.interrupt(current, cx), { danger: true })))
        .when(!stage, (element) => element.child(div().text_size(12).text_color(t.accent).child("모든 역할의 인수인계를 마쳤습니다.")))
        .child(div().flex_1())
        .child(this.button(t, "team-export", "기록 내보내기", (cx) => this.perform(cx, "기록 내보내는 중…", async () => {
          const path = await this.runtime.exportRun(current.id);
          this.notice = `팀 기록을 저장했습니다: ${path}`;
        }), { small: true })))
      .when(stage?.report?.status === "blocked", (element) => element.child(div().text_size(11).text_color(t.blocked).child("차단 이슈를 해결하고 보고서를 갱신한 뒤 다음 단계로 진행할 수 있습니다.")));
  }

  liveWorkView(current, t) {
    const stage = activeStage(current);
    const terminalState = {
      working: "AI 작업 중", blocked: "입력·권한 확인 기다림", idle: "CLI 응답 대기",
      done: "CLI 응답 종료", finished: "프로세스 종료", unknown: "연결 상태 확인 중",
    }[stage?.terminalState];
    const detail = !stage ? "역할별 결과와 실행 기록을 확인할 수 있습니다."
      : stage.launchUncertain ? "실행 응답을 확인하고 있습니다. 같은 시도를 중복 실행하지 않습니다."
        : stage.status === "pending" ? "이 역할은 아직 실행하지 않았습니다. 아래 단계 실행으로 시작하세요."
          : stage.status === "launching" ? "담당 AI의 실행 응답을 기다리고 있습니다."
            : stage.status === "ready" ? "보고서가 준비되었습니다. 내용을 확인한 뒤 다음 역할에 인수인계하세요."
              : stage.status === "error" ? "실행 또는 보고서 확인에 문제가 있습니다. 오류와 터미널을 확인하세요."
                : stage.status === "stopped" ? "이 역할이 중지되었습니다. 상태와 결과를 확인한 뒤 다시 실행할 수 있습니다."
                  : terminalState || "담당 AI의 터미널 상태를 확인하고 있습니다.";
    return v_flex().id("team-live-work").p(15).gap(10).rounded(9).border_1().border_color(t.accent + "66").bg(t.raised)
      .child(h_flex().gap(12).items_center().flex_wrap()
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child("실시간 작업"))
          .child(div().text_size(11).text_color(t.muted).child("같은 Space의 작업 탭에서 담당 AI의 터미널을 3분할로 봅니다.")))
        .child(this.button(t, "team-open-workspace", "실시간 작업 탭 열기", (cx) => this.openWorkspace(current, cx), { primary: true })))
      .when(Boolean(stage), (element) => element.child(h_flex().gap(8).items_center().flex_wrap()
        .child(div().text_size(12).font_medium().text_color(t.foreground).child(`현재 역할: ${stage.roleName} · ${this.toolName(stage.agent)}`))
        .child(this.badge(t, current.status === "paused" ? "paused" : stage.status))))
      .when(Boolean(stage), (element) => element.child(v_flex().gap(4)
        .child(div().id("team-current-model").text_size(11.5).text_color(t.muted).child(`현재 실행 설정 · 모델: ${stage.model || "도구 기본 모델"}`))
        .child(div().id("team-current-effort").text_size(11.5).text_color(t.muted).child(`추론 강도: ${this.effortName(stage)}`))
        .child(div().text_size(10.5).text_color(t.dim).child("도구 기본값이나 별칭의 최종 모델은 터미널에서 확인할 수 있습니다."))))
      .child(div().id("team-current-state").text_size(11.5).text_color(t.muted).child(detail))
      .when(Boolean(stage?.error || stage?.reportError), (element) => element.child(div().id("team-live-error").text_size(11).text_color(t.blocked).child(stage.error || stage.reportError)))
      .when(Boolean(this.workspaceError), (element) => element.child(div().id("team-workspace-error").text_size(11).text_color(t.blocked).child(`작업 화면을 열거나 갱신하지 못했습니다: ${this.workspaceError}`)))
      .child(div().text_size(10.5).text_color(t.dim).child("탭이나 Space를 바꿔도 팀의 진행을 유지합니다. 작업 탭을 여는 것만으로 AI를 새로 실행하지 않습니다."));
  }

  runView(current, t) {
    const selected = this.selectedStage();
    const compact = this.width < 760;
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("team-run-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(22).gap(17)
        .child(v_flex().gap(7)
          .child(h_flex().gap(12).items_center()
            .child(div().flex_1().min_w(0).text_size(20).font_semibold().text_color(t.foreground).child(current.title))
            .child(this.badge(t, current.status, current.status === "completed" ? "팀 단계 완료" : null)))
          .child(div().text_size(12).text_color(t.muted).child(current.goal))
          .child(div().text_size(11).text_color(t.dim).child(current.folder)))
        .child(this.liveWorkView(current, t))
        .child((compact ? v_flex() : h_flex()).w_full().min_w(0).items_start().gap(18)
          .child(this.stepsView(current, selected, t, compact))
          .child(this.reportView(current, selected, t))))
      .child(this.runControls(current, t));
  }

  historyView(t) {
    const history = [...this.state.runs].sort((left, right) => right.updatedAt - left.updatedAt);
    return v_flex().id("team-history-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(22).gap(12)
      .child(h_flex().gap(10).items_center().child(div().flex_1().text_size(19).font_semibold().text_color(t.foreground).child("팀 작업 기록"))
        .child(div().text_size(11).text_color(t.dim).child(`${history.length}개 작업`)))
      .when(!history.length, (element) => element.child(v_flex().py(32).gap(10).items_center()
        .child(svg("mods/team/team.svg").size(34).text_color(t.dim))
        .child(div().text_size(14).text_color(t.foreground).child("아직 팀 작업 기록이 없습니다"))
        .child(div().text_size(12).text_color(t.muted).child("새 작업을 시작하면 역할별 진행 상태와 보고서가 이곳에 남습니다."))
        .child(this.button(t, "team-history-new", "새 작업 만들기", (cx) => this.navigate("new", cx), { primary: true }))))
      .children(history.map((current) => v_flex().id(`team-history-${current.id}`).p(15).gap(8).rounded(9).border_1().border_color(t.border).bg(t.raised).cursor_pointer()
        .hover((style) => style.bg(t.hover)).on_click((_event, cx) => this.openRun(current.id, cx))
        .child(h_flex().gap(10).items_center().child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child(current.title))
          .child(this.badge(t, current.status, current.status === "completed" ? "팀 단계 완료" : null)))
        .child(div().text_size(12).text_color(t.muted).child(current.goal))
        .child(v_flex().gap(4).children(current.stages.map((stage) => div().id(`team-history-assignee-${current.id}-${stage.id}`)
          .truncate().tooltip(`${stage.roleName}: ${this.assignee(stage)}`).text_size(10.5).text_color(t.muted).child(`${stage.roleName}: ${this.assignee(stage)}`))))
        .child(h_flex().gap(10).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(current.folder))
          .child(div().text_size(10.5).text_color(t.dim).child(`${current.stages.filter((stage) => stage.status === "completed").length}/${current.stages.length} 인수인계 · ${dateLabel(current.updatedAt)}`)))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().text_size(10.5).text_color(t.dim).child("보관하면 프로젝트에 기록을 남기고 이 목록에서 제거합니다."))
          .child(this.button(t, `team-archive-${current.id}`, "기록 보관", (cx) => this.perform(cx, "기록 보관 중…", async () => {
            const path = await this.runtime.archive(current.id);
            this.notice = `프로젝트에 기록을 보관했습니다: ${path}`;
          }), { small: true, disabled: !current.stages.every((stage) => ["pending", "completed"].includes(stage.status)) })))))
      .child(div().pt(6).text_size(11).text_color(t.dim).child("기록을 여는 것만으로 AI를 다시 실행하지 않습니다."));
  }

  render(cx) {
    if (this.workspaceView) return this.workspaceView.render(cx);
    if (!this.isCheck) this.state = this.runtime.getState();
    const t = theme();
    const current = this.currentRun();
    const screen = this.screen === "run" && !current ? "new" : this.screen;
    const tab = (id, label) => div().id(`team-nav-${id}`).h(33).px(11).rounded(6).flex().items_center().justify_center().text_size(12)
      .bg(screen === id ? t.selected : t.popover).text_color(screen === id ? t.foreground : t.muted).cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.navigate(id, cx)).child(label);
    return v_flex().id("ai-team").track_focus(this.handle).size_full().min_h(0).min_w(0).bg(t.popover).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_key_down((event, cx) => {
        if (event.key === "escape") { this.dismiss(cx); cx.stop_propagation(); }
      })
      .child(h_flex().flex_none().h(57).px(20).gap(11).items_center()
        .when(!this.embedded, (element) => element.cursor_grab())
        .child(svg("mods/team/team.svg").size(22).text_color(t.accent))
        .child(v_flex().flex_1().gap(2).child(div().text_size(17).font_semibold().child("AI 팀"))
          .child(div().text_size(10.5).text_color(t.dim).child(this.embedded ? "팀 관리 · 다른 탭이나 Space에서도 진행을 유지합니다" : "역할을 나누고, 결과를 확인하고, 다음으로 연결하세요")))
        .when(this.embedded && Boolean(current), (element) => element.child(this.button(t, "team-tab-workspace", "실시간 작업 탭", (cx) => this.openWorkspace(current, cx), { small: true })))
        .when(!this.embedded, (element) => element.child(this.button(t, "team-close", "닫기", (cx) => this.dismiss(cx), { small: true }))))
      .child(h_flex().flex_none().px(20).pb(10).gap(5).items_center().border_b(1).border_color(t.border)
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .child(tab("new", "새 작업"))
        .when(Boolean(current), (element) => element.child(tab("run", "진행 상황")))
        .child(tab("profiles", this.profilesDirty ? "역할 설정 ·" : "역할 설정"))
        .child(tab("history", "작업 기록")))
      .child(v_flex().flex_1().min_h(0).min_w(0).on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .child(screen === "profiles" ? this.profilesView(t) : screen === "history" ? this.historyView(t)
          : screen === "run" ? this.runView(current, t) : this.newView(t)))
      .when(Boolean(this.error || this.notice || this.busy), (element) => element.child(div().flex_none().px(20).py(10).border_t(1).border_color(t.border)
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .text_size(11.5).text_color(this.error ? t.blocked : this.notice ? t.accent : t.muted).child(this.error || this.busy || this.notice)));
  }
}
