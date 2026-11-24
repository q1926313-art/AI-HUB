// AI Hub team workflow, 2026-11-24. Host effects are injected for native use and tests.
import {
  STATE_KEY, LIMITS, readState, validateProfiles, createRun, activeStage, nextStage,
  updateStage, validateStart, buildPrompt, parseReport, reportMarkdown,
} from "./model.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const safeId = (id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,95}$/.test(id);
const psQuote = (word) => "'" + word.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&") + "'";
const stateWord = (terminal) => typeof terminal?.status === "string" ? terminal.status : terminal?.status?.state;
const textError = (error) => String(error?.message ?? error).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 2000);
// Module copies share this transient coordination lock. Persisted launch identity
// still permits recovery after hot reload or restart without guessing a retry.
const inFlight = new Set();

export function runDirectory(run) {
  if (!safeId(run?.id) || typeof run.folder !== "string" || /[\u0000-\u001f]/u.test(run.folder)) throw new Error("팀 기록 경로가 올바르지 않습니다.");
  const root = run.folder.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (!root.startsWith("/") && !/^[A-Za-z]:\//.test(root)) throw new Error("프로젝트 폴더는 절대 경로여야 합니다.");
  if (root.split("/").some((part) => part === "." || part === "..")) throw new Error("프로젝트 폴더에 상대 경로를 사용할 수 없습니다.");
  return root.replace(/\/$/, "") + "/.ai-hub/team/" + run.id;
}

export function reportFile(run, stage) {
  if (!safeId(stage?.id) || !Number.isSafeInteger(stage.attempt) || stage.attempt < 1) throw new Error("실행 단계가 올바르지 않습니다.");
  return runDirectory(run) + "/" + stage.id + "-" + stage.attempt + ".json";
}

// Each word is a distinct argument. The user's task is read from a file, keeping
// Windows' command line short and avoiding shell interpolation of task text.
export function launcherArguments(platform, argv, prompt, shell) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some((v) => typeof v !== "string" || !v || /[\u0000\r\n]/u.test(v))) throw new Error("AI 실행 명령이 올바르지 않습니다.");
  const command = [...argv, prompt];
  if (platform === "windows") {
    const line = "& " + command.map(psQuote).join(" ");
    if (line.length > 24000) throw new Error("실행 명령이 너무 깁니다. 도구의 실행 설정을 줄여 주세요.");
    // Native CLI failures stay observable; a successful interactive session leaves a shell.
    return [shell || "powershell.exe", "-NoLogo", "-NoExit", "-Command", "$global:LASTEXITCODE = 0; try { " + line + "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } catch { Write-Error $_; exit 1 }"];
  }
  const selected = shell || "/bin/sh";
  const name = selected.split("/").at(-1);
  const login = platform === "macos";
  if (name === "fish") return [selected, login ? "-lic" : "-ic", "command $argv[2..]; set -l ai_hub_exit $status; if test $ai_hub_exit -ne 0; exit $ai_hub_exit; end; exec $argv[1] " + (login ? "-li" : "-i"), selected, ...command];
  const compatible = ["sh", "bash", "zsh", "dash", "ksh"].includes(name);
  const actual = compatible ? selected : "/bin/sh";
  return [actual, compatible ? (login ? "-lic" : "-ic") : "-c", '"$@"; ai_hub_exit=$?; if [ "$ai_hub_exit" -ne 0 ]; then exit "$ai_hub_exit"; fi; exec "$0" ' + (login ? "-li" : "-i"), selected, ...command];
}

export function createRuntime(host) {
  const lockKey = (id) => (host.appHome?.() || "ai-hub") + "\n" + id;
  const now = () => host.now ? host.now() : Date.now();
  const getState = () => readState(host.shared(STATE_KEY));
  const store = (state) => {
    if (JSON.stringify(state).length > LIMITS.state) throw new Error("팀 기록 저장 한도에 도달했습니다. 완료된 작업을 기록 보관한 뒤 다시 시도해 주세요.");
    host.setShared(STATE_KEY, state); return state;
  };
  const find = (id) => {
    const run = getState().runs.find((item) => item.id === id);
    if (!run) throw new Error("팀 작업을 찾을 수 없습니다.");
    return run;
  };
  const replace = (run) => {
    const state = getState();
    if (!state.runs.some((item) => item.id === run.id)) throw new Error("팀 작업이 변경되었습니다. 다시 열어 주세요.");
    store({ ...state, runs: state.runs.map((item) => item.id === run.id ? run : item) });
    return run;
  };
  const patchRun = (id, patch) => replace({ ...find(id), ...patch, updatedAt: now() });
  const patchStage = (id, stageId, patch, attempt) => {
    const run = find(id), stage = run.stages.find((item) => item.id === stageId);
    if (!stage || (attempt !== undefined && stage.attempt !== attempt)) return run;
    patch = { ...patch };
    for (const field of ["error", "reportError"]) if (patch[field] != null) patch[field] = textError(patch[field]);
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(stage[key]) === JSON.stringify(value))) return run;
    return replace(updateStage(run, stageId, patch, now()));
  };
  const result = (response, operation) => {
    if (!response || response.code !== 0) throw new Error(operation + ": " + (response?.stderr || response?.stdout || "응답 없음").trim().slice(0, 1800));
    return response;
  };
  const json = (response, operation) => {
    const raw = result(response, operation).stdout;
    try { return JSON.parse(raw); } catch { throw new Error(operation + ": 실행 엔진의 응답을 읽을 수 없습니다."); }
  };
  const exclusively = async (id, fn, quiet = false) => {
    const key = lockKey(id);
    if (inFlight.has(key)) { if (quiet) return find(id); throw new Error("이 팀 작업의 요청을 처리하고 있습니다."); }
    inFlight.add(key);
    try { return await fn(); } finally { inFlight.delete(key); }
  };
  const owned = (terminal, run, stage) => terminal?.labels?.["aihub.run"] === run.id && terminal.labels["aihub.stage"] === stage.id && terminal.labels["aihub.attempt"] === String(stage.attempt);
  const locate = async (run, stage) => {
    const answer = json(await host.hc(["ls", "--all", "--json", "--label", "aihub.run=" + run.id, "--label", "aihub.stage=" + stage.id, "--label", "aihub.attempt=" + stage.attempt]), "실행 확인");
    const matches = (answer.terminals ?? []).filter((terminal) => owned(terminal, run, stage));
    if (matches.length > 1) throw new Error("같은 단계의 실행이 여러 개입니다. 터미널을 확인해 주세요.");
    return matches[0] ?? null;
  };
  const inspect = async (run, stage) => {
    if (!stage.terminal) return locate(run, stage);
    const reply = await host.hc(["get", stage.terminal, "--json"]);
    if (reply.code !== 0) throw new Error("담당 AI의 상태를 확인하지 못했습니다. " + (reply.stderr || reply.stdout).slice(0, 1000));
    const terminal = json(reply, "담당 AI 상태 확인");
    if (!owned(terminal, run, stage)) throw new Error("터미널의 작업 정보가 일치하지 않습니다. 자동 진행을 멈췄습니다.");
    return terminal;
  };
  const shellFor = async (platform) => {
    if (platform === "windows") {
      try { if ((await host.exec("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { timeout: 5000 })).code === 0) return "pwsh.exe"; } catch {}
      return "powershell.exe";
    }
    try {
      const response = await host.exec("sh", ["-c", 'printf %s "${SHELL:-/bin/sh}"'], { timeout: 5000 });
      const shell = response.stdout?.trim();
      if (response.code === 0 && shell?.startsWith("/") && !/[\u0000\r\n]/u.test(shell)) return shell;
    } catch {}
    return "/bin/sh";
  };
  const ignoreRecords = async (run) => {
    // Local-only Git exclusion: no tracked .gitignore or project settings are edited.
    const top = await host.exec("git", ["rev-parse", "--show-toplevel"], { cwd: run.folder, timeout: 10000 }).catch(() => null);
    if (!top || top.code !== 0) return "";
    const root = top.stdout.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    const folder = run.folder.replace(/\\/g, "/").replace(/\/+$/, "");
    const same = (s) => /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
    if (same(folder) !== same(root) && !same(folder).startsWith(same(root) + "/")) return "기록 폴더의 Git 제외 경로를 확인하지 못했습니다.";
    const relative = folder.slice(root.length).replace(/^\//, "");
    const path = "/" + (relative ? relative + "/" : "") + ".ai-hub/team/";
    const pattern = path.replace(/[\\*?\[\] ]/g, "\\$&");
    const lookup = await host.exec("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: run.folder, timeout: 10000 });
    if (lookup.code !== 0) return "팀 기록은 Git 변경 목록에 나타날 수 있습니다.";
    const file = lookup.stdout.trim();
    if (!file || /[\u0000\r\n]/u.test(file)) return "Git 제외 파일 경로를 확인하지 못했습니다.";
    for (let retry = 0; retry < 2; retry++) {
      const old = await host.readTextFile(file);
      if (old?.split(/\r?\n/).includes(pattern)) return "";
      try { await host.writeTextFile(file, (old ?? "") + (old && !old.endsWith("\n") ? "\n" : "") + "# AI Hub local team records\n" + pattern + "\n", old); return ""; }
      catch (error) { if (retry) return "Git 제외 파일을 저장하지 못했습니다: " + textError(error); }
    }
    return "";
  };

  async function start(id, automatic = false) {
    let run = find(id), stage = nextStage(run);
    if (automatic && !run.autoAdvance) return run;
    if (!stage) throw new Error("실행할 다음 역할이 없습니다. 현재 역할의 보고서를 먼저 확인해 주세요.");
    const invalid = validateStart(run, stage);
    if (invalid) throw new Error(invalid);
    if (run.machine) throw new Error("첫 버전의 AI 팀은 이 컴퓨터의 프로젝트에서 실행합니다.");
    const previous = copy(stage);
    // Keep the previous attempt address until its safety check succeeds. A
    // failed check must not let a second retry forget a still-running program.
    if (previous.terminal) {
      const terminal = await inspect(run, previous);
      if (terminal?.state === "live" && !["idle", "done"].includes(stateWord(terminal))) throw new Error("이전 시도의 AI가 아직 실행 중일 수 있습니다. 해당 터미널을 먼저 확인해 주세요.");
      if (automatic && !find(id).autoAdvance) return find(id);
    }
    const attempt = (stage.attempt ?? 0) + 1;
    const launchKey = run.id + "-" + stage.id + "-" + attempt;
    patchStage(id, stage.id, { status: "launching", attempt, launchKey, terminal: null, report: null, error: null, reportError: null, terminalState: null, sawWorking: false, lastTurn: null, launchUncertain: false, startedAt: now(), finishedAt: null });
    run = patchRun(id, { status: "running" });
    stage = run.stages.find((item) => item.id === stage.id);
    let sent = false;
    try {
      const installed = await host.knownAgents({ on: null });
      const agent = installed.find((item) => item.key === stage.agent && item.installed);
      if (!agent?.run?.length) throw new Error(stage.agent + "를 실행할 수 없습니다. 해당 CLI를 설치·로그인한 뒤 다시 시도하거나 역할 설정을 바꾸어 새 팀 작업을 만드세요.");
      const reportPath = reportFile(run, stage);
      const briefPath = reportPath.replace(/\.json$/, ".md");
      const brief = buildPrompt(run, stage, reportPath);
      await host.writeTextFile(briefPath, brief, null);
      const warning = await ignoreRecords(run);
      if (warning) patchStage(id, stage.id, { reportError: warning }, attempt);
      const platform = host.window?.()?.platform || "linux";
      const shell = await shellFor(platform);
      const shortTask = "AI Hub 팀 작업입니다. 프로젝트 지침을 먼저 확인한 뒤 UTF-8 작업 지시서 " + JSON.stringify(briefPath) + "를 읽고 해당 역할만 수행하세요. 마지막에 지시서의 JSON 형식으로 인수인계 보고서를 " + JSON.stringify(reportPath) + "에 작성하세요. 기존 도구의 권한 정책을 유지하세요.";
      const argv = launcherArguments(platform, agent.run, shortTask, shell);
      const tab = "aihub-" + run.id + "-" + stage.id + "-" + attempt;
      const space = run.spaceId || "aihub-" + run.id;
      const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--no-notify", "--cwd", run.folder,
        "--label", "herdr.space=" + space, "--label", "herdr.tab=" + tab,
        "--label", "aihub.run=" + run.id, "--label", "aihub.stage=" + stage.id, "--label", "aihub.attempt=" + attempt,
        "--", ...argv];
      // Save target identity before starting: a late reply can be reconciled without duplicating the process.
      patchRun(id, { spaceId: space });
      if (automatic && !find(id).autoAdvance) {
        patchStage(id, stage.id, { status: "stopped", error: "자동 진행을 멈춰 이 역할은 실행하지 않았습니다." }, attempt);
        return patchRun(id, { status: "paused", autoAdvance: false });
      }
      sent = true;
      const terminal = json(await host.hc(args), "담당 AI 실행");
      if (!terminal.address || !owned(terminal, run, stage)) throw new Error("실행 결과의 작업 정보가 일치하지 않습니다.");
      patchStage(id, stage.id, { status: "running", terminal: terminal.address, terminalState: stateWord(terminal) || terminal.state || "unknown", lastTurn: terminal.turn ?? 0, sawWorking: stateWord(terminal) === "working" }, attempt);
      return find(id);
    } catch (error) {
      if (sent) {
        try {
          const terminal = await locate(find(id), find(id).stages.find((item) => item.id === stage.id));
          if (terminal) {
            patchStage(id, stage.id, { status: "running", terminal: terminal.address, terminalState: stateWord(terminal) || terminal.state || "unknown", lastTurn: terminal.turn ?? 0, sawWorking: stateWord(terminal) === "working", error: "실행 응답을 다시 확인했습니다. " + textError(error), launchUncertain: false }, attempt);
            return find(id);
          }
        } catch { /* The launch may still be in flight; absence is not proof of failure. */ }
        patchStage(id, stage.id, { error: "실행 여부를 확인하지 못했습니다. 중복 실행하지 않고 다시 연결을 기다립니다. " + textError(error), launchUncertain: true }, attempt);
        patchRun(id, { status: "paused", autoAdvance: false });
        throw error;
      }
      patchStage(id, stage.id, { status: "error", error: textError(error), launchUncertain: false }, attempt);
      patchRun(id, { status: "error", autoAdvance: false });
      throw error;
    }
  }

  async function collectInternal(id) {
    const run = find(id), stage = activeStage(run);
    if (!stage || !["running", "ready"].includes(stage.status) || !stage.attempt) return run;
    try {
      const raw = await host.readTextFile(reportFile(run, stage));
      if (raw === null || !raw.trim()) {
        if (stage.report) return patchStage(id, stage.id, { reportError: "보고서 파일이 없거나 비어 있습니다. 현재 파일이 확인될 때까지 전달하지 않습니다." }, stage.attempt);
        return run;
      }
      const report = parseReport(raw, run.id, stage.id, stage.attempt);
      const next = patchStage(id, stage.id, { status: "ready", report, reportError: null }, stage.attempt);
      if (report.status === "blocked") return patchRun(id, { status: "paused", autoAdvance: false });
      return next;
    } catch (error) {
      // An agent may still be writing. Preserve its current work and never advance on invalid data.
      return patchStage(id, stage.id, { reportError: "보고서 확인 대기: " + textError(error) }, stage.attempt);
    }
  }

  async function advanceInternal(id, automatic = false) {
    let run = find(id), stage = activeStage(run);
    if (!stage || stage.status !== "ready" || !stage.report) throw new Error("인수인계 보고서가 준비된 뒤 다음 역할로 넘길 수 있습니다.");
    if (automatic && (!run.autoAdvance || stage.reportError)) return run;
    const stageId = stage.id, attempt = stage.attempt;
    const terminal = await inspect(run, stage);
    if (!terminal) throw new Error("현재 담당자의 실행 상태를 확인하지 못했습니다.");
    run = find(id); stage = activeStage(run);
    if (!stage || stage.id !== stageId || stage.attempt !== attempt || stage.status !== "ready") return run;
    if (automatic && !run.autoAdvance) return run;
    // Re-read at the handoff boundary; cached reports cannot stand in for a
    // deleted, partly rewritten, or replaced report belonging to this attempt.
    const raw = await host.readTextFile(reportFile(run, stage));
    const report = parseReport(raw, id, stageId, attempt);
    run = find(id); stage = activeStage(run);
    if (!stage || stage.id !== stageId || stage.attempt !== attempt || stage.status !== "ready") return run;
    if (automatic && !run.autoAdvance) return run;
    if (report.status !== "completed") throw new Error("이 역할이 막힌 이유를 해결한 뒤 완료 보고서를 준비해 주세요.");
    patchStage(id, stage.id, { report, reportError: null }, attempt);
    const word = stateWord(terminal);
    if (["working", "blocked", "error"].includes(word)) throw new Error("현재 담당 AI가 아직 작업 중이거나 입력을 기다립니다.");
    if (terminal.reason && !["exited"].includes(terminal.reason)) throw new Error("실행이 중단되거나 복구된 기록입니다. 담당자의 결과를 다시 확인해 주세요.");
    if (terminal.state === "finished" && terminal.exit_code !== 0) throw new Error("현재 담당자의 실행이 정상 종료되지 않았습니다.");
    if (automatic) {
      const observed = stage.sawWorking || (Number(terminal.turn) > Number(stage.lastTurn ?? 0));
      if (!(terminal.state === "finished" && terminal.exit_code === 0) && !(observed && ["idle", "done"].includes(word))) return run;
      if (report.tests.some((test) => test.result === "fail") || report.issues.length) return patchRun(id, { status: "paused", autoAdvance: false });
    }
    run = patchStage(id, stage.id, { status: "completed", finishedAt: now(), error: null }, stage.attempt);
    if (!nextStage(run)) return patchRun(id, { status: "completed", autoAdvance: false });
    if (automatic && !find(id).autoAdvance) return patchRun(id, { status: "paused", autoAdvance: false });
    return start(id, automatic);
  }

  async function refreshInternal(id, autoAdvance) {
    let run = find(id), stage = activeStage(run);
    if (!stage || !["launching", "running", "ready"].includes(stage.status)) return run;
    try {
      const terminal = await inspect(run, stage);
      if (!terminal) {
        if (stage.status === "launching") {
          return patchStage(id, stage.id, { launchUncertain: true, error: "실행 여부 확인 대기 중입니다. 늦은 실행을 중복하지 않도록 같은 시도를 다시 확인합니다." }, stage.attempt);
        }
        return run;
      }
      const word = stateWord(terminal);
      const terminalState = terminal.state === "finished" ? "finished:" + terminal.exit_code : (terminal.reason || word || "unknown");
      const sawWorking = stage.sawWorking || word === "working" || Number(terminal.turn ?? 0) > Number(stage.lastTurn ?? 0);
      const patch = { terminal: terminal.address, terminalState, sawWorking, lastTurn: terminal.turn ?? stage.lastTurn, launchUncertain: false };
      if (stage.status === "launching") patch.status = "running";
      patchStage(id, stage.id, patch, stage.attempt);
      if ((terminal.state === "finished" && terminal.exit_code !== 0) || (terminal.reason && terminal.reason !== "exited")) {
        patchStage(id, stage.id, { status: "error", error: "담당 AI 실행이 중단되었습니다: " + (terminal.reason || terminal.exit_code) }, stage.attempt);
        return patchRun(id, { status: "error", autoAdvance: false });
      }
      if (["blocked", "error"].includes(word)) patchRun(id, { status: "paused", autoAdvance: false });
      run = await collectInternal(id);
      stage = activeStage(run);
      if (terminal.state === "finished" && !stage?.report) patchStage(id, stage.id, { reportError: "실행은 끝났지만 인수인계 보고서가 없습니다. 터미널 결과를 확인해 주세요." }, stage.attempt);
      if (autoAdvance && run.autoAdvance && run.status !== "error" && stage?.status === "ready" && !stage.reportError) return advanceInternal(id, true);
      return find(id);
    } catch (error) {
      patchStage(id, stage.id, { error: textError(error) }, stage.attempt);
      return patchRun(id, { status: "paused", autoAdvance: false });
    }
  }

  return {
    getState,
    saveProfiles(profiles) {
      const validated = validateProfiles(profiles), state = getState();
      store({ ...state, profiles: validated });
      return validated;
    },
    create(input) {
      const state = getState();
      if (input.machine || input.spaceId?.includes("/")) throw new Error("첫 버전의 AI 팀은 이 컴퓨터의 프로젝트에서 실행합니다.");
      if (state.runs.length >= LIMITS.runs) throw new Error("팀 작업 기록이 " + LIMITS.runs + "개입니다. 완료된 작업을 기록 보관한 뒤 새 작업을 만들어 주세요.");
      const id = host.makeId ? host.makeId() : "team-" + now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
      if (!safeId(id) || state.runs.some((item) => item.id === id)) throw new Error("새 작업 ID를 만들지 못했습니다. 다시 시도해 주세요.");
      const run = createRun({ ...input, profiles: input.profiles ?? state.profiles }, { id, now: now() });
      runDirectory(run);
      store({ ...state, runs: [run, ...state.runs], selectedRunId: run.id });
      return run;
    },
    select(id) { if (id) find(id); const state = getState(); store({ ...state, selectedRunId: id || null }); return getState(); },
    launch(id) { return exclusively(id, () => start(id)); },
    collect(id) { return exclusively(id, () => collectInternal(id)); },
    advance(id) { return exclusively(id, () => advanceInternal(id)); },
    refresh(id, options = {}) { return exclusively(id, () => refreshInternal(id, options.autoAdvance === true), true); },
    pause(id) { return patchRun(id, { status: "paused", autoAdvance: false }); },
    setAuto(id, enabled) { return patchRun(id, { autoAdvance: Boolean(enabled) }); },
    saveReport(id, text) {
      return exclusively(id, async () => {
        const run = find(id), stage = activeStage(run);
        if (!stage || !["running", "ready"].includes(stage.status)) throw new Error("현재 실행의 보고서만 수정할 수 있습니다.");
        const report = parseReport(text, id, stage.id, stage.attempt), file = reportFile(run, stage);
        const old = await host.readTextFile(file);
        await host.writeTextFile(file, JSON.stringify(report, null, 2) + "\n", old);
        return patchStage(id, stage.id, { status: "ready", report, reportError: null }, stage.attempt);
      });
    },
    interrupt(id) {
      return exclusively(id, async () => {
        const run = patchRun(id, { status: "paused", autoAdvance: false }), stage = activeStage(run);
        if (!stage?.terminal) throw new Error("중지할 담당 AI의 터미널이 아직 확인되지 않았습니다.");
        const terminal = await inspect(run, stage);
        if (terminal.state === "finished") return patchStage(id, stage.id, { status: "stopped", error: "실행이 이미 종료되었습니다." }, stage.attempt);
        const answer = json(await host.hc(["interrupt", stage.terminal, "--json", "--timeout", "3"]), "중지 요청");
        const stopped = ["stopped", "exited"].includes(answer.outcome);
        return patchStage(id, stage.id, { ...(stopped ? { status: "stopped" } : {}), error: stopped ? "담당 AI의 작업 중지를 확인했습니다." : "중지 신호를 보냈습니다. 실제 중지 여부는 터미널에서 확인해 주세요." }, stage.attempt);
      });
    },
    openTerminal(id, stageId) {
      const run = find(id), stage = run.stages.find((item) => item.id === stageId);
      if (!stage?.terminal) throw new Error("아직 담당 AI의 터미널이 없습니다.");
      host.run("terminal.peek", { terminal: stage.terminal });
    },
    exportRun(id) {
      return exclusively(id, async () => {
        const run = find(id), dir = runDirectory(run);
        const markdown = ["# " + run.title, "", "## 작업 목표", run.goal, "", "프로젝트: " + run.folder, "", "이 문서의 검사 결과는 각 AI가 보고한 내용입니다.", "", ...run.stages.flatMap((stage) => ["## " + stage.roleName + " · " + stage.agent, "상태: " + stage.status, "", stage.report ? reportMarkdown(stage.report) : "인수인계 보고서 없음", ""])].join("\n");
        const file = dir + "/handoff.md", old = await host.readTextFile(file);
        await host.writeTextFile(file, markdown, old);
        return file;
      });
    },
    archive(id) {
      return exclusively(id, async () => {
        const run = find(id);
        if (!run.stages.every((stage) => ["pending", "completed"].includes(stage.status))) throw new Error("실행 중인 작업은 보관할 수 없습니다. 담당 역할을 마친 뒤 보관하세요.");
        const file = runDirectory(run) + "/run.json", old = await host.readTextFile(file);
        await host.writeTextFile(file, JSON.stringify(run, null, 2) + "\n", old);
        const state = getState();
        store({ ...state, runs: state.runs.filter((item) => item.id !== id), selectedRunId: state.selectedRunId === id ? null : state.selectedRunId });
        return file;
      });
    },
  };
}
