// AI Hub (2026-11-24): native team workspace. Agents report work; people review handoffs.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  theme, spaces, panes, props, checking, closeOverlay, nextCommand, pickFolder,
  shared, setShared, hc, exec, run, knownAgents, readTextFile, writeTextFile, appHome, window,
} from "herdr";
import { defaultProfiles, readState, activeStage, nextStage } from "./model.js";
import { createRuntime } from "./runtime.js";

const TOOL_NAMES = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
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
    this.isCheck = checking();
    this.runtime = this.isCheck ? null : createRuntime({
      shared, setShared, hc, exec, run, knownAgents, readTextFile, writeTextFile, appHome, window,
    });
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
    this.profilesDirty = false;
    this.reportEditing = false;
    this.reportDirty = false;
    this.reportStageId = null;
    this.width = 960;
    this.newAuto = false;
    this.handle = cx.focus_handle();
    const project = this.isCheck ? { folder: "", spaceId: null, remote: false } : localProject();
    this.projectSpaceId = project.spaceId;
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
    for (const input of Object.values(this.profileInputs ?? {})) input.release();
    this.profileDraft = copy(profiles ?? defaultProfiles());
    this.profileInputs = {};
    for (const profile of this.profileDraft) {
      const input = TextareaState.new({ value: profile.instructions, rows: 3 });
      input.on("change", (_event, cx) => { this.profilesDirty = true; this.notice = null; cx.notify(); });
      this.profileInputs[profile.id] = input;
    }
    this.profilesDirty = false;
    this.agentPicker = null;
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
    this.closed = true;
    this.stopAutomatic();
  }

  dismiss(cx) {
    if (this.reportDirty) {
      this.error = "편집한 보고서를 저장하거나 편집 취소 후 창을 닫아 주세요.";
      cx?.notify();
      return;
    }
    this.stopAutomatic();
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  navigate(screen, cx) {
    this.screen = screen;
    this.notice = null;
    this.error = null;
    if (screen !== "run") this.stopAutomatic();
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
      try { await action(); }
      catch (error) { this.error = message(error); this.disarm(); }
      finally {
        this.busy = null;
        this.syncState();
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.isCheck || this.closed || this.busy || this.refreshing || this.screen !== "run") return;
    this.syncState();
    const current = this.currentRun();
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
        this.projectSpaceId = null;
        this.remoteProject = false;
      }
    });
  }

  start(cx) {
    const input = {
      title: this.titleInput.value().trim(), goal: this.goalInput.value().trim(),
      folder: this.folderInput.value().trim(), spaceId: this.projectSpaceId,
      machine: null, autoAdvance: this.newAuto,
    };
    this.perform(cx, "첫 역할을 시작하는 중…", async () => {
      const current = this.runtime.create(input);
      this.runtime.select(current.id);
      this.runtime.setAuto(current.id, this.newAuto);
      this.screen = "run";
      this.selectedStageId = current.stages[0]?.id ?? null;
      this.reportEditing = false;
      this.reportDirty = false;
      this.armed = true;
      this.armedRunId = current.id;
      await this.runtime.launch(current.id);
    });
  }

  openRun(id, cx) {
    if (this.isCheck || this.busy) return;
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
    this.perform(cx, "역할을 시작하는 중…", async () => {
      this.armed = true;
      this.armedRunId = current.id;
      this.selectedStageId = activeStage(current)?.id ?? null;
      this.reportEditing = false;
      this.reportDirty = false;
      await this.runtime.launch(current.id);
    });
  }

  advance(current, cx) {
    this.perform(cx, "인수인계를 연결하는 중…", async () => {
      this.armed = true;
      this.armedRunId = current.id;
      await this.runtime.advance(current.id);
      this.selectedStageId = null;
      this.reportEditing = false;
      this.reportDirty = false;
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
    const profiles = this.profileDraft.map((profile) => ({ ...profile, instructions: this.profileInputs[profile.id].value() }));
    this.perform(cx, "역할 설정 저장 중…", () => {
      this.runtime.saveProfiles(profiles);
      this.profilesDirty = false;
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
        .child(h_flex().items_center().justify_between().child(this.label(t, "함께할 역할"))
          .child(this.button(t, "team-edit-roles", "역할 설정", (cx) => this.navigate("profiles", cx), { small: true })))
        .children(profiles.map((profile, index) => h_flex().px(12).py(9).gap(10).items_center().rounded(7).bg(t.raised)
          .child(div().size(23).flex_none().rounded(6).bg(t.background).text_color(t.accent).text_size(11).flex().items_center().justify_center().child(String(index + 1)))
          .child(div().flex_1().text_size(12).text_color(t.foreground).child(profile.name))
          .child(div().text_size(12).text_color(t.muted).child(this.toolName(profile.agent)))
          .child(div().w(70).text_right().text_size(10.5).text_color(this.toolHint(profile.agent) === "설치 필요" ? t.blocked : t.dim).child(this.toolHint(profile.agent))))))
      .child(this.toggle(t, "team-new-auto", this.newAuto, "보고서가 준비되면 다음 역할 자동 실행", (cx) => { this.newAuto = !this.newAuto; cx.notify(); },
        "기본은 직접 확인 후 진행입니다. 자동 실행 중에도 보고서에 차단 이슈가 있으면 멈춥니다."))
      .child(h_flex().gap(12).items_center()
        .child(this.button(t, "team-start", "AI 팀 시작", (cx) => this.start(cx), { primary: true, disabled: !valid }))
        .child(div().flex_1().text_size(11).text_color(t.dim).child("팀 기록은 프로젝트의 .ai-hub/team에 저장됩니다.")));
  }

  agentChoices(profile, t) {
    const choices = this.agents.length ? this.agents : Object.entries(TOOL_NAMES).map(([key, name]) => ({ key, name, installed: null }));
    return v_flex().id(`team-tools-${profile.id}`).h(Math.min(200, choices.length * 32 + 8)).min_h(0).overflow_y_scrollbar().p(4).gap(2).rounded(7).border_1().border_color(t.border).bg(t.background)
      .children(choices.map((agent) => h_flex().id(`team-tool-${profile.id}-${agent.key}`).h(30).flex_none().px(9).gap(10).rounded(5).items_center().cursor_pointer()
        .bg(agent.key === profile.agent ? t.selected : t.background).hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => {
          profile.agent = agent.key; this.agentPicker = null; this.profilesDirty = true; this.notice = null; cx.notify();
        })
        .child(div().w(14).text_color(t.accent).child(agent.key === profile.agent ? "✓" : ""))
        .child(div().flex_1().text_size(12).text_color(t.foreground).child(agent.name))
        .child(div().text_size(10.5).text_color(agent.installed === false ? t.blocked : t.dim).child(agent.installed === null ? "설치 확인 전" : agent.installed ? "사용 가능" : "설치 필요"))));
  }

  profilesView(t) {
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("team-profiles-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(22).gap(14)
        .child(v_flex().gap(5).child(div().text_size(19).font_semibold().text_color(t.foreground).child("역할별 도구와 지침"))
          .child(div().text_size(12).text_color(t.muted).child("순서대로 넘겨받을 역할을 설정하세요. 저장한 설정은 새 작업에 적용됩니다.")))
        .child(h_flex().gap(10).items_center()
          .child(this.button(t, "team-agent-refresh", this.agentsLoading ? "도구 확인 중…" : "설치된 도구 다시 확인", (cx) => this.loadAgents(cx), { small: true, disabled: this.agentsLoading }))
          .when(Boolean(this.agentsError), (element) => element.child(div().flex_1().text_size(11).text_color(t.blocked).child(`도구 확인 실패: ${this.agentsError}`))))
        .children(this.profileDraft.map((profile, index) => v_flex().p(14).gap(10).rounded(9).border_1().border_color(t.border).bg(t.raised)
          .child(h_flex().gap(9).items_center()
            .child(div().size(24).rounded(6).bg(t.background).text_color(t.accent).text_size(11).flex().items_center().justify_center().child(String(index + 1)))
            .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child(profile.name))
            .child(this.button(t, `team-profile-toggle-${profile.id}`, profile.enabled !== false ? "사용 중" : "제외됨", (cx) => {
              profile.enabled = profile.enabled === false; this.profilesDirty = true; cx.notify();
            }, { small: true })))
          .child(h_flex().gap(10).items_center().child(div().text_size(11).text_color(t.muted).child("담당 도구"))
            .child(this.button(t, `team-profile-agent-${profile.id}`, `${this.toolName(profile.agent)}  ▾`, (cx) => {
              this.agentPicker = this.agentPicker === profile.id ? null : profile.id; cx.notify();
            }, { small: true }))
            .child(div().text_size(10.5).text_color(this.toolHint(profile.agent) === "설치 필요" ? t.blocked : t.dim).child(this.toolHint(profile.agent))))
          .when(this.agentPicker === profile.id, (element) => element.child(this.agentChoices(profile, t)))
          .child(this.field(t, Textarea.new(this.profileInputs[profile.id])).h(94)))))
      .child(h_flex().flex_none().px(22).py(13).gap(10).items_center().border_t(1).border_color(t.border)
        .child(this.button(t, "team-profile-defaults", "기본 역할 불러오기", (cx) => {
          this.setProfileEditors(defaultProfiles()); this.profilesDirty = true; this.notice = null; cx.notify();
        }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.profilesDirty ? "저장하지 않은 변경사항" : "저장된 역할 설정"))
        .child(this.button(t, "team-profile-save", "역할 저장", (cx) => this.saveProfiles(cx), { primary: true, disabled: !this.profilesDirty })));
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
        .when(Boolean(stage.terminal), (element) => element.child(this.button(t, `team-terminal-${stage.id}`, "터미널 열기", (cx) => {
          if (this.isCheck) return;
          try { this.runtime.openTerminal(current.id, stage.id); }
          catch (error) { this.error = message(error); cx.notify(); }
        }, { small: true })))));
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

  render() {
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
      .child(h_flex().flex_none().h(57).px(20).gap(11).items_center().cursor_grab()
        .child(svg("mods/team/team.svg").size(22).text_color(t.accent))
        .child(v_flex().flex_1().gap(2).child(div().text_size(17).font_semibold().child("AI 팀"))
          .child(div().text_size(10.5).text_color(t.dim).child("역할을 나누고, 결과를 확인하고, 다음으로 연결하세요")))
        .child(this.button(t, "team-close", "닫기", (cx) => this.dismiss(cx), { small: true })))
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
