// AI Hub: live terminal chrome. The original Team view owns execution.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, checking, shared, setShared, closeOverlay, openOverlay, terminals } from "herdr";
import { readState, activeStage, STATE_KEY } from "./model.js";
import { WORKSPACE_KEY, TOOL_NAMES, choicesFor, dismissWorkspace, changeWorkspace } from "./workspace.js";

const STATUS = { pending: "대기", launching: "연결 확인 중", running: "작업 중", ready: "보고서 확인 필요", completed: "완료", stopped: "중지됨", error: "확인 필요" };
const host = { shared, setShared };
const toolName = (stage, binding) => TOOL_NAMES[stage?.agent] ?? stage?.agent ?? TOOL_NAMES[binding?.choice?.slice(6)] ?? "담당 없음";

export default class Workspace extends View {
  init(_props, cx) {
    this.info = _props?.view === "workspace" ? _props : props() ?? {};
    this.isCheck = checking();
    if (!this.isCheck) cx.timer.every(1000, (cx) => cx.notify());
  }

  close() {
    if (!this.isCheck && this.info.role === "toolbar") dismissWorkspace(host, this.info.owner, this.info.generation);
  }

  current() {
    return readState(shared(STATE_KEY)).runs.find((current) => current.id === this.info.runId) ?? null;
  }

  button(t, id, label, action, selected = false) {
    return h_flex().id(id).flex_none().h(28).px(9).gap(5).items_center().justify_center().rounded(6)
      .bg(selected ? t.accent : t.raised).border_1().border_color(selected ? t.accent : t.border)
      .text_color(selected ? t.accent_foreground : t.foreground).text_size(11).cursor_pointer()
      .hover((style) => style.bg(selected ? t.accent : t.hover))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => { cx.stop_propagation(); if (!this.isCheck) action(cx); }).child(label);
  }

  back() {
    dismissWorkspace(host, this.info.owner, this.info.generation);
    if (this.info.overlay) closeOverlay(this.info.overlay);
  }

  picker(binding) {
    openOverlay({ mod: "team", kind: "popup", width: 340, height: 420,
      props: { ...this.info, view: "workspace", role: "picker", binding } });
  }

  toolbar(t, current) {
    const active = current && activeStage(current);
    const state = shared(WORKSPACE_KEY);
    const done = current?.stages.filter((stage) => stage.status === "completed").length ?? 0;
    const info = active ? `${active.roleName} · ${STATUS[active.status] ?? active.status}` : current?.status === "completed" ? "팀 작업 완료" : "팀 관리에서 시작하세요";
    const handoff = current?.status === "paused" ? "인수인계 일시 정지" : current?.autoAdvance ? "자동 인수인계 설정" : "수동 인수인계";
    return v_flex().size_full().px(6).gap(7)
      .child(h_flex().gap(12).items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(16).font_semibold().text_color(t.foreground).truncate().child(current?.title || "AI 팀 작업 화면"))
          .child(div().text_size(11).text_color(t.muted).child(`${info} · ${done}/${current?.stages.length ?? 0} 완료 · ${handoff}`)))
        .child(this.button(t, "workspace-back", "팀 관리 · 보고서", () => this.back())))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11).text_color(t.dim).child("왼쪽 너비"))
        .children([55, 65, 75].map((ratio) => this.button(t, "workspace-ratio-" + ratio, ratio + "%", () => {
          changeWorkspace(host, this.info.owner, this.info.generation, { ratio });
        }, (state?.ratio ?? 65) === ratio)))
        .child(div().flex_1().min_w(0).ml(8).truncate().text_size(11).text_color(t.dim).child("각 칸의 담당을 바꿀 수 있습니다. 실행·승인 요청은 터미널에 표시됩니다.")));
  }

  header(t, current, binding) {
    const stage = current?.stages.find((entry) => entry.id === binding?.stageId);
    const live = binding?.terminal && terminals().find((terminal) => terminal.address === binding.terminal);
    const waiting = ["blocked", "needs_input", "needs-input"].includes(live?.status);
    const stale = Boolean(stage && binding?.terminal && stage.attempt !== binding.attempt);
    const label = stale ? "이전 시도 · 화면 전환 중" : waiting ? "입력·승인 대기" : STATUS[stage?.status] ?? "배정된 역할 없음";
    const color = stale || waiting || ["ready", "error"].includes(stage?.status) ? t.blocked : stage?.status === "running" ? t.working : t.muted;
    return v_flex().size_full().px(10).py(7).gap(6)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).text_size(12).font_semibold().text_color(t.foreground).truncate().child(`${toolName(stage, binding)}${stage ? " · " + stage.roleName : ""}`))
        .child(div().text_size(10.5).text_color(color).child(label))
        .child(this.button(t, "workspace-assign-" + binding.slot, "담당 ▾", () => this.picker(binding))))
      .child(div().text_size(10.5).text_color(t.dim).truncate()
        .child(`${stage?.model || "도구 기본 모델"} · 추론 ${stage?.effort || "기본값"}${binding?.choice?.startsWith("agent:") ? " · 역할 자동 연결" : " · 역할 고정"}`));
  }

  placeholder(t, current, binding) {
    const stage = current?.stages.find((entry) => entry.id === binding?.stageId);
    const report = stage?.report;
    const title = binding?.duplicate ? "같은 실행이 다른 칸에 표시되어 있습니다"
      : !stage ? "이 도구에 배정된 역할이 없습니다"
      : stage.status === "pending" ? "앞 역할의 인수인계를 기다립니다"
      : stage.status === "launching" ? "실행한 터미널을 연결하고 있습니다"
      : stage.status === "error" ? "실행 상태를 확인해 주세요"
      : report ? "이 역할의 보고서가 도착했습니다" : "표시할 실행 터미널이 없습니다";
    return v_flex().id("workspace-placeholder-" + binding.slot).size_full().min_h(0).overflow_y_scrollbar().p(18).gap(12)
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(stage?.error || stage?.reportError || report?.summary
        || (stage?.status === "pending" ? "차례가 되어 팀이 실행하면 이 칸에 실제 작업 화면이 나타납니다." : "담당 메뉴에서 다른 역할을 고르거나 팀 관리에서 실행 상태와 보고서를 확인하세요.")))
      .when(Boolean(stage?.instructions && !report), (element) => element.child(div().text_size(11).text_color(t.dim).child(stage.instructions)))
      .when(Boolean(report), (element) => element.child(div().text_size(11).text_color(t.dim).child("상세 결과와 다음 역할 진행은 ‘팀 관리 · 보고서’에서 확인하세요.")));
  }

  choose(t, current, binding) {
    const options = choicesFor(current);
    return v_flex().id("workspace-choices").min_h(0).max_h(420).overflow_y_scrollbar().p(10).gap(7)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("이 칸에 표시할 담당"))
      .children(options.map((choice, index) => this.button(t, "workspace-choice-" + index, choice.name, () => {
        const state = shared(WORKSPACE_KEY);
        changeWorkspace(host, this.info.owner, this.info.generation, { choices: { ...state?.choices, [binding.slot]: choice.id } });
        closeOverlay(this.info.overlay);
      }, choice.id === binding.choice)));
  }

  render() {
    const t = theme(), current = this.current();
    const binding = this.info.binding ?? { slot: "left", choice: "agent:claude" };
    if (this.info.role === "toolbar") return this.toolbar(t, current);
    if (this.info.role === "header") return this.header(t, current, binding);
    if (this.info.role === "picker") return this.choose(t, current, binding);
    return this.placeholder(t, current, binding);
  }
}
