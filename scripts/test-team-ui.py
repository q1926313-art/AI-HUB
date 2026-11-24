#!/usr/bin/env python3
"""Check team mod descriptions and native elements on an isolated Xvfb display.

The real app/JS engine loads each state. This is a materialization check, not a
complete-frame screenshot or a test of a provider's coding agent. Logs and the
element descriptions remain in target/team-ui even when a scenario fails.

This mode does not dispatch clicks or resume async event handlers. Those paths
are covered by the real GPUI test team_clicks_resume_with_the_spawned_context
in src/mods/render_tests.rs; CI runs it before these description fixtures.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid


REPO = Path(__file__).resolve().parent.parent
PROFILE_SCENARIOS = ("profiles", "models", "claude-models", "codex-models", "effort-unsupported")
WORKSPACE_SCENARIOS = ("workspace-toolbar", "workspace-header", "workspace-placeholder", "workspace-picker")
SCENARIOS = ("empty", "embedded-empty", "draft", "running", "ready", "error", "busy-refresh", "history", "manager-navigation", *PROFILE_SCENARIOS, *WORKSPACE_SCENARIOS)


def fixture_entry(scenario: str) -> str:
    """Exercise the shipped view; only its in-memory check state is replaced."""
    if scenario in WORKSPACE_SCENARIOS:
        return workspace_fixture_entry(scenario.removeprefix("workspace-"))
    return """import Team from './mods/team/main.js';
import { createRun, defaultProfiles, readState, updateStage } from './mods/team/model.js';

export default class NativeTeamFixture extends Team {
  init(props, cx) {
    super.init({ embedded: true, space: 'native-team-space', tab: 'native-team-manager', pane: 'native-team-pane' }, cx);
    if (!this.embedded || this.placement.spaceId !== 'native-team-space'
      || this.placement.tabId !== 'native-team-manager' || this.placement.paneId !== 'native-team-pane'
      || this.runtime !== null || this.workspace !== null || this.armed) {
      throw new Error('The embedded manager lost its placement or initialized host execution during checking.');
    }
    const scenario = SCENARIO;
    if (scenario === 'embedded-empty') return;
    const now = 1700000000000;
    const profiles = defaultProfiles();
    if (['profiles', 'models', 'claude-models', 'codex-models', 'effort-unsupported'].includes(scenario)) {
      this.screen = 'profiles';
      this.agentsLoading = false;
      this.agents = [
        { key: 'claude', name: 'Claude Code', installed: true },
        { key: 'codex', name: 'Codex', installed: false },
        { key: 'opencode', name: 'OpenCode', installed: true },
      ];
      this.modelCatalogs.opencode = {
        models: [{ id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017', efforts: ['low', 'high'] }],
        loading: false, error: null, loaded: true,
      };
      if (scenario === 'profiles') {
        // Exercise native editor values and a non-default role count/order.
        // Input/Textarea values are not included in --print-spec, so check
        // them through the same native state API that the shipped view uses.
        const customId = 'custom-check';
        this.setProfileEditors([
          { ...profiles.find((profile) => profile.id === 'implement') },
          { ...profiles.find((profile) => profile.id === 'plan') },
          {
            id: customId, name: 'Native role before edit', agent: 'opencode',
            model: '', access: 'read', enabled: true,
            instructions: 'Native instructions before edit.',
          },
        ]);
        this.profileNames[customId].set_value('Native custom validation');
        this.profileModels[customId].set_value('opencode-go/deepseek-v4.1-flash');
        this.selectEffort(customId, 'high', cx);
        this.profileInputs[customId].set_value('Native custom instructions after editing.');
        this.moveRole(customId, -1, cx);
        this.moveRole(customId, -1, cx);
        const edited = this.collectProfiles();
        if (edited.map((profile) => profile.id).join(',') !== 'custom-check,implement,plan'
          || edited[0].name !== 'Native custom validation'
          || edited[0].agent !== 'opencode'
          || edited[0].model !== 'opencode-go/deepseek-v4.1-flash'
          || edited[0].effort !== 'high'
          || edited[0].instructions !== 'Native custom instructions after editing.'
          || edited[0].access !== 'read' || edited[1].access !== 'write'
          || !this.profilesDirty) {
          throw new Error('Native custom role edits or order were not preserved.');
        }
        this.agentPicker = customId;
      } else if (scenario === 'models') {
        this.modelCatalogs.opencode = {
          models: [
            { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017', efforts: ['low', 'high'] },
            { id: 'fixture-provider/unrelated-model', name: 'Native unrelated model' },
          ],
          loading: false, error: null, loaded: true,
        };
        this.modelPicker = 'implement';
        this.modelSearchInputs.implement.set_value('dEePsEeK');
        if (this.profileModels.implement.value() !== 'opencode-go/deepseek-v4.1-flash'
          || this.modelSearchInputs.implement.value() !== 'dEePsEeK'
          || this.profilesDirty) {
          throw new Error('Native model search changed the saved role or lost its model ID.');
        }
        this.folderInput.set_value('/tmp/another-opencode-project');
        const implementation = this.profileDraft.find((profile) => profile.id === 'implement');
        if (this.modelCatalog(implementation).loaded || this.modelCapability(implementation)
          || this.profileModels.implement.value() !== 'opencode-go/deepseek-v4.1-flash') {
          throw new Error('OpenCode reused another project catalog or discarded the selected model.');
        }
        this.folderInput.set_value('');
        if (!this.modelCapability(implementation)?.efforts?.includes('high')) {
          throw new Error('The matching project catalog lost its effort metadata.');
        }
      } else if (scenario === 'claude-models') {
        this.selectModel('plan', 'claude-opus-5-5', cx, 'claude');
        this.selectEffort('plan', 'high', cx);
        this.modelPicker = 'plan';
        this.modelSearchInputs.plan.set_value('CLAUDE-OPUS-5-5');
        const plan = this.collectProfiles().find((profile) => profile.id === 'plan');
        if (plan.model !== 'claude-opus-5-5' || plan.effort !== 'high' || !this.profilesDirty
          || this.profileEffortProblem(plan)) throw new Error('Claude model/effort selection was not preserved.');
      } else if (scenario === 'codex-models') {
        this.modelCatalogs.codex = {
          models: [{ id: 'native-codex-model', name: 'Native Codex cached model', source: 'codex-cache', efforts: ['low', 'xhigh'] }],
          loading: false, error: null, loaded: true,
        };
        this.selectModel('review', 'native-codex-model', cx, 'codex');
        this.selectEffort('review', 'xhigh', cx);
        this.modelPicker = 'review';
        const review = this.collectProfiles().find((profile) => profile.id === 'review');
        if (review.model !== 'native-codex-model' || review.effort !== 'xhigh' || !this.profilesDirty
          || this.profileEffortProblem(review)) throw new Error('Codex cache capability was not used for effort selection.');
      } else {
        this.profileModels.plan.set_value('claude-opus-5-5');
        const plan = this.profileDraft.find((profile) => profile.id === 'plan');
        plan.effort = 'ultra';
        this.updateProfilesDirty();
        if (!this.profileEffortProblem(plan) || this.collectProfiles()[0].effort !== 'ultra') {
          throw new Error('An unsupported stored effort was silently removed or accepted.');
        }
      }
      return;
    }
    if (scenario === 'running') {
      profiles[0].model = 'claude-opus-5-5';
      profiles[0].effort = 'high';
    }
    let run = createRun({
      title: `Native ${scenario} fixture`,
      goal: 'Implement an isolated native UI check without running a coding agent.',
      folder: '/tmp/ai-hub-native-fixture',
      profiles,
      autoAdvance: false,
    }, { id: 'aihub-native-fixture', now });
    const report = (stageId) => ({
      runId: run.id, stageId, attempt: 1, status: 'completed',
      summary: 'Native review fixture report', changes: [], tests: [], issues: [],
      next: 'Continue only after reviewing the report.',
    });
    if (scenario !== 'draft' && scenario !== 'history') {
      run = updateStage(run, 'plan', { status: 'launching', attempt: 1 }, now + 1);
      run = updateStage(run, 'plan', {
        status: 'running', terminal: 't-native-fixture', startedAt: now + 1,
      }, now + 2);
    }
    if (scenario === 'ready') {
      run = updateStage(run, 'plan', { status: 'ready', report: report('plan') }, now + 3);
    }
    if (scenario === 'error') {
      run = updateStage(run, 'plan', {
        status: 'error', error: 'Native fixture launch failed', finishedAt: now + 3,
      }, now + 3);
    }
    if (scenario === 'busy-refresh') {
      run = updateStage(run, 'plan', { status: 'error', error: 'Retry fixture' }, now + 3);
      run = updateStage(run, 'plan', { status: 'launching', attempt: 2, terminal: null }, now + 4);
    }
    if (scenario === 'history') {
      for (const stage of run.stages) {
        run = updateStage(run, stage.id, { status: 'launching', attempt: 1 }, now + 1);
        run = updateStage(run, stage.id, { status: 'running', terminal: 't-native-fixture' }, now + 2);
        run = updateStage(run, stage.id, { status: 'ready', report: report(stage.id) }, now + 3);
        run = updateStage(run, stage.id, {
          status: 'completed',
        }, now + 4);
      }
    }
    this.state = readState(JSON.stringify({
      version: 1, profiles, runs: [run], selectedRunId: run.id,
    }));
    if (scenario === 'running' && (this.state.runs[0].stages[0].model !== 'claude-opus-5-5'
      || this.state.runs[0].stages[0].effort !== 'high')) throw new Error('The running stage lost its requested model or effort.');
    this.screen = scenario === 'history' ? 'history' : 'run';
    this.selectedStageId = 'plan';
    this.agentsLoading = false;
    this.setReportEditor(this.state.runs[0].stages[0]);
    this.reportEditing = scenario === 'ready';
    if (scenario === 'busy-refresh') {
      // Async tab updates are covered by the VM and workspace tests; this
      // fixture materializes the actual deferred-retry controls and new attempt.
      this.busy = 'Native deferred retry setup';
    }
    if (scenario === 'manager-navigation') {
      this.armed = true;
      this.armedRunId = run.id;
      this.navigate('profiles', cx);
      if (!this.armed || this.armedRunId !== run.id) throw new Error('Role navigation paused the embedded controller.');
      this.agentPicker = 'plan';
      this.dismiss(cx);
      if (this.agentPicker !== null || !this.armed || this.screen !== 'profiles') throw new Error('Embedded Esc did not close only the selector.');
      this.dismiss(cx);
      if (this.screen !== 'run' || !this.armed) throw new Error('Embedded Esc changed execution instead of navigation.');
      this.navigate('history', cx);
      if (!this.armed) throw new Error('History navigation paused the embedded controller.');
      this.navigate('run', cx);
    }
  }
}
""".replace("SCENARIO", json.dumps(scenario))


def workspace_fixture_entry(role: str) -> str:
    """Check the real routed entry without a process, live terminal, or writes."""
    return """import Team from './mods/team/main.js';
import { createRun, defaultProfiles, updateStage } from './mods/team/model.js';

export default class NativeWorkspaceFixture extends Team {
  init(props, cx) {
    const role = ROLE;
    const profiles = defaultProfiles();
    profiles[0].model = 'claude-opus-5-5';
    profiles[0].effort = 'high';
    let current = createRun({
      title: 'Native workspace fixture', goal: 'Show existing work without starting another agent.',
      folder: '/tmp/ai-hub-workspace-fixture', profiles, autoAdvance: false,
    }, { id: 'aihub-workspace-fixture', now: 1700000000000 });
    if (role !== 'placeholder') {
      current = updateStage(current, 'plan', { status: 'launching', attempt: 1 }, current.updatedAt + 1);
      current = updateStage(current, 'plan', { status: 'running', terminal: 't-native-workspace' }, current.updatedAt + 1);
    }
    const info = { view: 'workspace', role, runId: current.id, owner: 'native-check', generation: 1,
      spaceId: 'native-team-space', managerTabId: 'native-team-manager', workspaceTabId: 'native-team-workspace',
      binding: { slot: 'left', choice: 'agent:claude', stageId: 'plan', attempt: current.stages[0].attempt, terminal: null } };
    super.init(info, cx);
    if (!this.workspaceView || this.workspaceView.info.view !== 'workspace'
      || this.workspaceView.info.role !== role || this.runtime !== undefined
      || this.workspace !== undefined || this.armed !== undefined || this.titleInput !== undefined) {
      throw new Error('A workspace route initialized the Team controller or lost its role props.');
    }
    this.workspaceView.current = () => current;
    let closed = false;
    const actualClose = this.workspaceView.close.bind(this.workspaceView);
    this.workspaceView.close = () => { closed = true; actualClose(); };
    this.close();
    this.workspaceView.close = actualClose;
    if (!closed || this.closed !== undefined) throw new Error('Workspace close did not delegate to the display view.');
  }
}
""".replace("ROLE", json.dumps(role))


def run_check(command: list[str], env: dict[str, str], seconds: int) -> tuple[int, str, str]:
    # Only this check's private process group is terminated on a timeout.
    process = subprocess.Popen(
        command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=seconds)
        return process.returncode, stdout, stderr
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        return 124, stdout, stderr + f"\nNative check exceeded {seconds} seconds.\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=REPO / "target/debug/herdr-app")
    parser.add_argument("--output", type=Path, default=REPO / "target/team-ui")
    parser.add_argument("--timeout", type=int, default=60, help="seconds per scenario")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    summary = {"scope": "native descriptions and eager materialization; no full-frame pixels", "scenarios": []}
    binary = args.binary.resolve()
    try:
        if sys.platform != "linux":
            raise RuntimeError("the native team smoke check requires Linux and Xvfb")
        if args.timeout <= 0:
            raise RuntimeError("--timeout must be a positive number of seconds")
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError(f"app executable not found: {binary}")
        xvfb = shutil.which("xvfb-run")
        if not xvfb:
            raise RuntimeError("xvfb-run is missing; install xvfb and xauth")
        if not (REPO / "defaults/mods/team/main.js").is_file():
            raise RuntimeError("the shipped team mod entry is missing")

        for scenario in SCENARIOS:
            with tempfile.TemporaryDirectory(prefix=f"ai-hub-team-{scenario}-") as scratch:
                root = Path(scratch)
                env = os.environ.copy()
                for key in ("HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "WAYLAND_DISPLAY"):
                    env.pop(key, None)
                for key, folder in (
                    ("HERDR_APP_HOME", "app"), ("AI_HUB_HOME", "app"),
                    ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                    ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache"),
                    ("XDG_RUNTIME_DIR", "runtime"),
                ):
                    path = root / folder
                    path.mkdir(mode=0o700, exist_ok=True)
                    env[key] = str(path)
                env["HC_SESSION"] = f"ai-hub-team-{uuid.uuid4().hex}"
                env["HERDR_APP_NO_SOUND"] = "1"

                module = REPO / "defaults/mods/team"
                if scenario != "empty":
                    # Preserve relative imports/assets without modifying shipped code.
                    shutil.copytree(REPO / "defaults", root, dirs_exist_ok=True)
                    (root / "main.js").write_text(fixture_entry(scenario), encoding="utf-8")
                    module = root
                command = [xvfb, "-a", "-s", "-screen 0 1440x1000x24 -nolisten tcp",
                           str(binary), "check", str(module), "--print-spec"]
                code, stdout, stderr = run_check(command, env, args.timeout)
                (output / f"{scenario}.spec.txt").write_text(stdout, encoding="utf-8")
                (output / f"{scenario}.log").write_text(stderr, encoding="utf-8")
                errors = []
                if code != 0:
                    errors.append(f"checker exited {code}")
                if "check passed: " not in stdout:
                    errors.append("checker did not confirm native materialization")
                expected = [] if scenario in WORKSPACE_SCENARIOS else ["AI 팀"]
                if scenario in ("empty", "embedded-empty"):
                    expected.extend(["어떤 일을 함께 할까요?", "AI 팀 시작", "모델·추론 설정", "시작하면 실시간 작업 탭으로 이동", "추론 강도"])
                elif scenario in PROFILE_SCENARIOS:
                    expected.extend([
                        "역할별 도구와 지침", "역할 저장", "설치 필요", "OpenCode",
                        "Input #", "Textarea #", "자문·검토", "구현·수정", "추론 강도",
                    ])
                    if scenario == "profiles":
                        expected.extend([
                            "3/8개 역할", "저장하지 않은 변경사항", "↑ 위로", "↓ 아래로", "역할 삭제",
                            "team-profile-custom-check", "team-profile-implement", "team-profile-plan",
                        ])
                    elif scenario == "models":
                        expected.extend([
                            "모델 목록 다시 불러오기", "1개 검색 결과 · 전체 2개",
                            "DeepSeek V4.1 Flash 1017", "opencode-go/deepseek-v4.1-flash",
                            "team-model-option-implement-0", "저장된 역할 설정",
                        ])
                    elif scenario == "claude-models":
                        expected.extend(["Claude Opus 5.5", "claude-opus-5-5", "team-model-option-plan-0", "team-effort-plan-high", "높음 (high)"])
                    elif scenario == "codex-models":
                        expected.extend(["Native Codex cached model", "native-codex-model", "team-model-option-review-0", "team-effort-review-xhigh", "매우 높음 (xhigh)"])
                    else:
                        expected.extend(["현재 값: ultra", "지원하지 않습니다", "team-effort-plan-default"])
                elif scenario in WORKSPACE_SCENARIOS:
                    expected.extend({
                        "workspace-toolbar": ["Native workspace fixture", "계획", "수동 인수인계", "팀 관리 · 보고서", "workspace-ratio-65"],
                        "workspace-header": ["Claude Code · 계획", "claude-opus-5-5", "추론 high", "역할 자동 연결", "workspace-assign-left"],
                        "workspace-placeholder": ["앞 역할의 인수인계를 기다립니다", "실제 작업 화면이 나타납니다", "workspace-placeholder-left"],
                        "workspace-picker": ["이 칸에 표시할 담당", "선택 접기", "Claude Code · 현재 역할 따라가기", "계획 · Claude Code", "구현 · OpenCode", "검토 · Codex"],
                    }[scenario])
                else:
                    expected.append(f"Native {scenario} fixture")
                    if scenario != "history":
                        expected.extend(["실시간 작업 탭 열기", "team-open-workspace", "team-current-model", "추론 강도"])
                if scenario not in WORKSPACE_SCENARIOS and scenario != "empty":
                    expected.append("팀 관리 · 다른 탭이나 Space에서도 진행을 유지합니다")
                    if "team-close" in stdout:
                        errors.append("an embedded manager still exposes the popup close control")
                if scenario == "running":
                    expected.extend(["claude-opus-5-5", "높음 (high)", "현재 실행 설정"])
                if scenario == "ready":
                    expected.append("Native review fixture report")
                if scenario == "error":
                    expected.append("Native fixture launch failed")
                if scenario == "history":
                    expected.append("팀 작업 기록")
                for value in expected:
                    if value not in stdout:
                        errors.append(f"expected content is missing from the description: {value}")
                if scenario == "profiles":
                    positions = [stdout.find(f"team-profile-{role}") for role in ("custom-check", "implement", "plan")]
                    if min(positions) < 0 or positions != sorted(positions):
                        errors.append("the description did not preserve the custom role order")
                if scenario == "models":
                    for value in ("Native unrelated model", "fixture-provider/unrelated-model"):
                        if value in stdout:
                            errors.append(f"model search exposed an unrelated result: {value}")
                if scenario in WORKSPACE_SCENARIOS and ("undefined ·" in stdout or "· undefined" in stdout):
                    errors.append("workspace chrome used an undefined role label")
                if "check: mod " in stdout + stderr:
                    errors.append("the checking view attempted a real process or file-write side effect")
                result = {"name": scenario, "exit_code": code, "passed": not errors, "errors": errors}
                summary["scenarios"].append(result)
                print(f"{scenario}: {'PASS' if not errors else 'FAIL'}", flush=True)
                if errors:
                    print("\n".join(errors), file=sys.stderr)
                    print(stderr, file=sys.stderr)
    except (OSError, RuntimeError) as error:
        summary["error"] = str(error)
        print(error, file=sys.stderr)
    finally:
        (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return 0 if "error" not in summary and len(summary["scenarios"]) == len(SCENARIOS) and all(
        item["passed"] for item in summary["scenarios"]
    ) else 1


if __name__ == "__main__":
    raise SystemExit(main())
