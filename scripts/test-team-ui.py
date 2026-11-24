#!/usr/bin/env python3
"""Check team mod descriptions and native elements on an isolated Xvfb display.

The real app/JS engine loads each state. This is a materialization check, not a
complete-frame screenshot or a test of a provider's coding agent. Logs and the
element descriptions remain in target/team-ui even when a scenario fails.
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
SCENARIOS = ("empty", "draft", "running", "ready", "error", "history", "profiles", "models")


def fixture_entry(scenario: str) -> str:
    """Exercise the shipped view; only its in-memory check state is replaced."""
    return """import Team from './mods/team/main.js';
import { createRun, defaultProfiles, readState, updateStage } from './mods/team/model.js';

export default class NativeTeamFixture extends Team {
  init(props, cx) {
    super.init(props, cx);
    const scenario = SCENARIO;
    const now = 1700000000000;
    const profiles = defaultProfiles();
    if (scenario === 'profiles' || scenario === 'models') {
      this.screen = 'profiles';
      this.agentsLoading = false;
      this.agents = [
        { key: 'claude', name: 'Claude Code', installed: true },
        { key: 'codex', name: 'Codex', installed: false },
        { key: 'opencode', name: 'OpenCode', installed: true },
      ];
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
        this.profileInputs[customId].set_value('Native custom instructions after editing.');
        this.moveRole(customId, -1, cx);
        this.moveRole(customId, -1, cx);
        const edited = this.collectProfiles();
        if (edited.map((profile) => profile.id).join(',') !== 'custom-check,implement,plan'
          || edited[0].name !== 'Native custom validation'
          || edited[0].agent !== 'opencode'
          || edited[0].model !== 'opencode-go/deepseek-v4.1-flash'
          || edited[0].instructions !== 'Native custom instructions after editing.'
          || edited[0].access !== 'read' || edited[1].access !== 'write'
          || !this.profilesDirty) {
          throw new Error('Native custom role edits or order were not preserved.');
        }
        this.agentPicker = customId;
      } else {
        this.modelCatalogs.opencode = {
          models: [
            { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017' },
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
      }
      return;
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
    this.screen = scenario === 'history' ? 'history' : 'run';
    this.selectedStageId = 'plan';
    this.agentsLoading = false;
    this.setReportEditor(this.state.runs[0].stages[0]);
    this.reportEditing = scenario === 'ready';
  }
}
""".replace("SCENARIO", json.dumps(scenario))


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
                expected = ["AI 팀"]
                if scenario == "empty":
                    expected.extend(["어떤 일을 함께 할까요?", "AI 팀 시작"])
                elif scenario in ("profiles", "models"):
                    expected.extend([
                        "역할별 도구와 지침", "역할 저장", "설치 필요", "OpenCode",
                        "Input #", "Textarea #", "자문·검토", "구현·수정",
                    ])
                    if scenario == "profiles":
                        expected.extend([
                            "3/8개 역할", "저장하지 않은 변경사항", "↑ 위로", "↓ 아래로", "역할 삭제",
                            "team-profile-custom-check", "team-profile-implement", "team-profile-plan",
                        ])
                    else:
                        expected.extend([
                            "모델 목록 다시 불러오기", "1개 검색 결과 · 전체 2개",
                            "DeepSeek V4.1 Flash 1017", "opencode-go/deepseek-v4.1-flash",
                            "team-model-option-implement-0", "저장된 역할 설정",
                        ])
                else:
                    expected.append(f"Native {scenario} fixture")
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
