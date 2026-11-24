// AI Hub team runtime contract checks. No model requests, accounts, or real core are used.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, reportFile, launcherArguments, agentArguments, parseModelList, parseCodexModelCache, parseOpenCodeModelMetadata, capturedArguments } from "../defaults/mods/team/runtime.js";
import { STATE_KEY, LIMITS, defaultProfiles } from "../defaults/mods/team/model.js";

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const okay = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
// Actual hc CLI contract: run/ls use cli/output.rs::short (no labels), while
// get returns the full record. Keeping these different prevents API-shaped
// mocks from hiding a launch/recovery ownership regression.
const compactTerminal = (terminal) => ({ address: terminal.address, state: terminal.state, status: terminal.status?.state, turn: terminal.turn,
  ...(terminal.reason ? { reason: terminal.reason } : {}), ...(terminal.exit_code == null ? {} : { exit_code: terminal.exit_code }) });
let harnessSequence = 0;

function harness(placement) {
  const home = "/home/test/ai-hub-test-" + (++harnessSequence);
  const data = new Map(), files = new Map(), terminals = new Map(), effects = [];
  let clock = 10000, sequence = 0, idSequence = 0;
  const controls = {
    run: null, ls: null, get: null, exec: null, interrupt: "stopped", installed: ["claude", "codex", "opencode"], configured: {},
    models: "opencode-go/deepseek-v4.1-flash\nopencode/deepseek-v4.1-flash\n",
    rootHelp: "  -m, --model  provider/model\n      --prompt  initial prompt\n",
    miniHelp: "  --model <string>\n  --prompt <string>\n",
    modelsHelp: "", apiHelp: "", runHelp: null, metadata: null, verboseModels: "", codexHome: "",
    claudeHelp: "  --model <model>\n  --effort <level>\n",
    codexHelp: "  -m, --model <MODEL>\n  -c, --config <key=value>\n",
  };
  const host = {
    ...(placement === undefined ? {} : { placement }),
    shared(key) { return clone(data.get(key)); },
    setShared(key, value) { data.set(key, clone(value)); },
    now: () => ++clock,
    makeId: () => "team-test-" + (++idSequence),
    window: () => ({ platform: "linux" }),
    appHome: () => home,
    home: () => "/home/test",
    async knownAgents() { return controls.installed.map((key) => ({ key, installed: true, run: controls.configured[key] ?? (key === "codex" ? ["codex", "--no-daemon"] : [key]) })); },
    async readTextFile(file) { effects.push(["read", file]); return files.get(file) ?? null; },
    async writeTextFile(file, text, expected) {
      assert.equal(files.get(file) ?? null, expected, "writes use a current expected snapshot");
      effects.push(["write", file]); files.set(file, text);
    },
    async exec(command, args, options) {
      effects.push(["exec", command, args, options]);
      if (controls.exec) return controls.exec(command, args, options);
      if (command === "git") return { code: 128, stdout: "", stderr: "not a repository" };
      if (command === "opencode") {
        if (args.includes("--help")) return okay(args[0] === "--help" ? controls.rootHelp : args[0] === "models" ? controls.modelsHelp : args[0] === "api" ? controls.apiHelp : args[0] === "run" ? (controls.runHelp ?? controls.miniHelp) : controls.miniHelp);
        if (args[0] === "models" && args.includes("--verbose")) return okay(controls.verboseModels);
        if (args[0] === "models") return okay(controls.models);
        if (args[0] === "api" && args[1] === "model.list") return okay(controls.metadata);
      }
      if (command === "claude" && args.includes("--help")) return okay(controls.claudeHelp);
      if (command === "codex" && args.includes("--help")) return okay(controls.codexHelp);
      if (command === "sh" && args.at(-1).includes("CODEX_HOME")) return okay(controls.codexHome);
      if (["powershell.exe", "pwsh.exe"].includes(command)) {
        const script = args.at(-1);
        if (script.includes("$PSVersionTable")) return okay("7.5");
        if (script.includes("$env:CODEX_HOME")) return okay(controls.codexHome);
        if (script.includes("'opencode' 'models' '--help'")) return okay(controls.modelsHelp);
        if (script.includes("'opencode' 'api' '--help'")) return okay(controls.apiHelp);
        if (script.includes("'opencode' 'models' '--verbose'")) return okay(controls.verboseModels);
        if (script.includes("'opencode' 'api' 'model.list'")) return okay(controls.metadata);
        if (script.includes("'opencode' 'models'")) return okay(controls.models);
        if (script.includes("'opencode' '--help'")) return okay(controls.rootHelp);
        if (script.includes("'opencode' 'mini' '--help'")) return okay(controls.miniHelp);
        if (script.includes("'opencode' 'run' '--help'")) return okay(controls.runHelp ?? controls.miniHelp);
        if (script.includes("'claude' '--help'")) return okay(controls.claudeHelp);
        if (script.includes("'codex' '--help'")) return okay(controls.codexHelp);
      }
      return okay("/bin/bash");
    },
    run(command, args) { effects.push(["app", command, args]); },
    async hc(args) {
      effects.push(["hc", args]);
      if (args[0] === "run") {
        const labels = {};
        for (let i = 1; i < args.indexOf("--"); i++) if (args[i] === "--label") {
          const entry = args[++i], at = entry.indexOf("="); labels[entry.slice(0, at)] = entry.slice(at + 1);
        }
        const terminal = { address: "t" + (++sequence), labels, state: "live", status: { state: "idle" }, turn: 0, reason: null, exit_code: null, argv: args.slice(args.indexOf("--") + 1) };
        if (controls.run) return controls.run(terminal, terminals);
        terminals.set(terminal.address, terminal);
        return okay(compactTerminal(terminal));
      }
      if (args[0] === "ls") {
        if (controls.ls) return controls.ls();
        const filters = args.flatMap((arg, i) => arg === "--label" ? [args[i + 1]] : []);
        return okay({ terminals: [...terminals.values()].filter((terminal) => filters.every((filter) => {
          const at = filter.indexOf("="); return terminal.labels[filter.slice(0, at)] === filter.slice(at + 1);
        })).map(compactTerminal) });
      }
      if (args[0] === "get") {
        if (controls.get) return controls.get(args[1]);
        const value = terminals.get(args[1]);
        return value ? okay(value) : { code: 1, stdout: "", stderr: "not_found" };
      }
      if (args[0] === "interrupt") return okay({ outcome: controls.interrupt, key: "esc" });
      throw new Error("Unexpected core call: " + args.join(" "));
    },
  };
  const runtime = createRuntime(host);
  const create = (overrides = {}) => runtime.create({ title: "팀 작업", goal: "사용자의 기존 파일을 보존하며 한 가지 문제를 수정", folder: "/work/project", spaceId: "sp1", ...overrides });
  const current = (id) => runtime.getState().runs.find((run) => run.id === id);
  const stage = (id) => current(id).stages.find((entry) => entry.status !== "completed");
  const ready = (id, overrides = {}) => {
    const run = current(id), item = stage(id);
    const report = { runId: id, stageId: item.id, attempt: item.attempt, status: "completed", summary: "실제로 수행한 작업", changes: [], tests: [{ command: "검사", result: "not_run", detail: "읽기 전용 계획 단계" }], issues: [], next: "다음 역할의 작업", ...overrides };
    files.set(reportFile(run, item), JSON.stringify(report));
    return report;
  };
  return { runtime, host, controls, data, files, terminals, effects, create, current, stage, ready };
}

test("native placement keeps every role and retry in one manager tab without starting on create", async () => {
  const placement = { spaceId: "spteam", tabId: "tbmanager" };
  const h = harness(placement);
  const profiles = defaultProfiles(); profiles[0].name = "내 계획 역할";
  h.runtime.saveProfiles(profiles);
  const run = h.create({ autoAdvance: true, spaceId: "spother", tabId: "tbother" });
  assert.equal(run.spaceId, "spteam"); assert.equal(run.tabId, "tbmanager");
  assert.equal(run.stages[0].roleName, "내 계획 역할");
  h.runtime.select(run.id); h.runtime.getState();
  assert.deepEqual(h.effects, [], "binding, creating and selecting do not execute a CLI or prepare a report");
  placement.tabId = "tbchanged";
  await h.runtime.launch(run.id);
  await h.runtime.interrupt(run.id);
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).attempt, 2);
  for (const role of ["plan", "implement", "review", "verify"]) {
    assert.equal(h.stage(run.id).id, role);
    h.ready(run.id); await h.runtime.collect(run.id); await h.runtime.advance(run.id);
  }
  assert.equal(h.current(run.id).status, "completed");
  assert.equal(h.terminals.size, 5, "one retry plus four sequential roles");
  assert.deepEqual([...new Set([...h.terminals.values()].map((terminal) => terminal.labels["herdr.space"]))], ["spteam"]);
  assert.deepEqual([...new Set([...h.terminals.values()].map((terminal) => terminal.labels["herdr.tab"]))], ["tbmanager"]);
  assert.deepEqual(h.runtime.getState().profiles, profiles, "placement does not replace custom role settings");
});

test("reopening an old run binds only its next launch and preserves the current report and identity", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id); h.ready(run.id); await h.runtime.collect(run.id);
  const previous = clone(h.stage(run.id)), originalTerminal = clone(h.terminals.get(previous.terminal));
  const stateBefore = clone(h.data.get(STATE_KEY)), effectsBefore = h.effects.length;
  const manager = createRuntime({ ...h.host, placement: { spaceId: "spteam", tabId: "tbmanager" } });
  manager.getState(); manager.select(run.id);
  assert.deepEqual(h.data.get(STATE_KEY), stateBefore, "opening/selecting does not migrate a running record or grant execution");
  assert.equal(h.effects.length, effectsBefore);
  await assert.rejects(manager.launch(run.id), /실행할 다음 역할/);
  assert.deepEqual(h.stage(run.id), previous, "a ready role is not restarted during rebinding");
  await manager.advance(run.id);
  const current = h.current(run.id), completed = current.stages[0];
  assert.equal(current.spaceId, "spteam"); assert.equal(current.tabId, "tbmanager");
  assert.equal(completed.status, "completed");
  assert.equal(completed.terminal, previous.terminal); assert.equal(completed.attempt, previous.attempt);
  assert.deepEqual(completed.report, previous.report);
  assert.deepEqual(h.terminals.get(previous.terminal), originalTerminal, "old terminal relocation belongs to the native workspace, not the runtime");
  assert.equal(h.terminals.get(current.stages[1].terminal).labels["herdr.tab"], "tbmanager");
  assert.deepEqual(current.stages.slice(2), run.stages.slice(2), "later role snapshots remain untouched");
});

test("reopening persisted placement without manager props reuses its tab while old runs keep legacy labels", async () => {
  const h = harness({ spaceId: "spteam", tabId: "tbmanager" }), run = h.create();
  const { placement: _, ...legacyHost } = h.host;
  const reopened = createRuntime(legacyHost);
  await reopened.launch(run.id);
  assert.equal(h.terminals.get("t1").labels["herdr.tab"], "tbmanager");
  const legacy = harness(), oldRun = legacy.create();
  assert.equal(oldRun.tabId, null);
  await legacy.runtime.launch(oldRun.id);
  assert.equal(legacy.terminals.get("t1").labels["herdr.space"], oldRun.spaceId);
  assert.equal(legacy.terminals.get("t1").labels["herdr.tab"], "aihub-" + oldRun.id + "-plan-1");
});

test("placement rejects remote or malformed destinations before any effects", () => {
  const h = harness();
  for (const placement of [false, [], {}, { spaceId: "spteam" }, { spaceId: "remote/sp1", tabId: "tb1" },
    { spaceId: "sp1", tabId: "remote/tb1" }, { spaceId: "sp1", tabId: "tb1", machine: "remote" },
    { spaceId: "sp1\n", tabId: "tb1" }, { spaceId: "sp1", tabId: "../tab" }, { spaceId: "sp1", tabId: "a".repeat(97) }])
    assert.throws(() => createRuntime({ ...h.host, placement }), /이 컴퓨터/);
  assert.deepEqual(h.effects, []); assert.equal(h.data.size, 0);
});

test("rebinding does not discard the previous attempt when retry preflight fails", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id); await h.runtime.interrupt(run.id);
  const previous = clone(h.current(run.id));
  const manager = createRuntime({ ...h.host, placement: { spaceId: "spteam", tabId: "tbmanager" } });
  h.terminals.get("t1").status.state = "working";
  await assert.rejects(manager.launch(run.id), /이전 시도의 AI가 아직 실행 중/);
  assert.deepEqual(h.current(run.id), previous);
  h.controls.get = () => ({ code: 1, stdout: "", stderr: "core offline" });
  await assert.rejects(manager.launch(run.id), /core offline/);
  assert.deepEqual(h.current(run.id), previous, "a failed preflight keeps the old placement and attempt identity");
  h.controls.get = null; h.terminals.get("t1").status.state = "idle";
  await manager.launch(run.id);
  assert.equal(h.current(run.id).spaceId, "spteam"); assert.equal(h.current(run.id).tabId, "tbmanager");
  assert.equal(h.stage(run.id).attempt, previous.stages[0].attempt + 1);
  assert.equal(h.terminals.get("t2").labels["herdr.tab"], "tbmanager");
});

test("four roles execute in order and each receives the original goal and prior reports", async () => {
  const h = harness(), run = h.create();
  await h.runtime.launch(run.id);
  for (const [index, role] of ["plan", "implement", "review", "verify"].entries()) {
    let stage = h.stage(run.id);
    assert.equal(stage.id, role);
    assert.equal(stage.status, "running");
    const brief = h.files.get(reportFile(h.current(run.id), stage).replace(/\.json$/, ".md"));
    assert.ok(brief.includes(run.goal));
    if (index) assert.ok(brief.includes("실제로 수행한 작업"), "prior work is carried over");
    h.ready(run.id);
    await h.runtime.collect(run.id);
    await h.runtime.advance(run.id);
  }
  assert.equal(h.current(run.id).status, "completed");
  assert.equal(h.effects.filter((e) => e[0] === "hc" && e[1][0] === "run").length, 4);
  const codex = [...h.terminals.values()].find((t) => t.labels["aihub.stage"] === "review");
  assert.ok(codex.argv.includes("--no-daemon"), "the configured CLI arguments are retained");
  assert.equal(h.runtime.getState().runs.length, 1, "the persisted completed run remains valid");
});

test("a second panel cannot launch the same role twice", async () => {
  const h = harness(), run = h.create();
  let release;
  h.host.knownAgents = () => new Promise((resolve) => { release = () => resolve([{ key: "claude", installed: true, run: ["claude"] }]); });
  const first = h.runtime.launch(run.id);
  const other = createRuntime(h.host);
  try { await assert.rejects(other.launch(run.id)); }
  finally { release(); await first; }
  assert.equal(h.terminals.size, 1);
});

test("missing CLI fails visibly without starting a program or discarding the run", async () => {
  const h = harness(), run = h.create(); h.controls.installed = ["codex"];
  await assert.rejects(h.runtime.launch(run.id), /claude/);
  assert.equal(h.stage(run.id).status, "error");
  assert.equal(h.terminals.size, 0);
  assert.equal(h.current(run.id).status, "error");
});

test("late launch replies reconnect by exact labels instead of duplicating a CLI", async () => {
  const h = harness(), run = h.create();
  h.controls.run = (terminal, list) => { list.set(terminal.address, terminal); throw new Error("connection lost after spawn"); };
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).status, "running");
  assert.equal(h.stage(run.id).terminal, "t1");
  assert.equal(h.terminals.size, 1);
});

test("a compact hc run reply is resolved with get before accepting its ownership", async () => {
  const h = harness(), run = h.create();
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).terminal, "t1");
  assert.equal(h.stage(run.id).launchUncertain, false);
  assert.equal(h.stage(run.id).error, null);
  assert.deepEqual(h.effects.filter((effect) => effect[0] === "hc").map((effect) => effect[1][0]), ["run", "get"]);
});

test("an installed 0.1.19 uncertain launch reconnects and collects its report without restarting AI", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  const state = h.host.shared(STATE_KEY), saved = state.runs[0], stage = saved.stages[0];
  Object.assign(saved, { status: "paused", autoAdvance: false });
  Object.assign(stage, { status: "launching", attempt: 1, launchKey: run.id + "-plan-1", startedAt: 10000,
    launchUncertain: true, error: "실행 결과의 작업 정보가 일치하지 않습니다." });
  h.data.set(STATE_KEY, state);
  h.terminals.set("t37", { address: "t37", labels: { "aihub.run": run.id, "aihub.stage": "plan", "aihub.attempt": "1" },
    state: "live", status: { state: "idle" }, turn: 1, exit_code: null, reason: null });
  h.ready(run.id);
  const reopened = createRuntime(h.host);
  await reopened.refresh(run.id, { autoAdvance: true });
  assert.equal(h.stage(run.id).status, "ready");
  assert.equal(h.stage(run.id).terminal, "t37");
  assert.equal(h.stage(run.id).attempt, 1);
  assert.equal(h.stage(run.id).launchUncertain, false);
  assert.equal(h.stage(run.id).error, null, "the stale mismatch is cleared once full ownership is verified");
  assert.ok(h.stage(run.id).report);
  assert.equal(h.current(run.id).autoAdvance, false);
  assert.deepEqual(h.effects.filter((effect) => effect[0] === "hc").map((effect) => effect[1][0]), ["ls", "get"]);
  assert.equal(h.effects.some((effect) => ["exec", "write"].includes(effect[0])), false);
});

test("compact candidates never bypass mismatched ownership, duplicate attempts, or malformed responses", async () => {
  for (const mode of ["wrong-label", "wrong-address", "duplicate", "malformed-list"]) {
    const h = harness(), run = h.create();
    h.controls.run = (terminal, list) => {
      list.set(terminal.address, terminal);
      if (mode === "duplicate") list.set("t2", { ...clone(terminal), address: "t2" });
      throw new Error("late run response");
    };
    if (mode === "wrong-label") h.controls.get = (id) => okay({ ...h.terminals.get(id), labels: { "aihub.run": "another-run" } });
    if (mode === "wrong-address") h.controls.get = (id) => okay({ ...h.terminals.get(id), address: "t999" });
    if (mode === "malformed-list") h.controls.ls = () => okay({ unrelated: [] });
    await assert.rejects(h.runtime.launch(run.id), /late run response/, mode);
    await h.runtime.refresh(run.id);
    await assert.rejects(h.runtime.launch(run.id), undefined, mode);
    assert.equal(h.stage(run.id).terminal, null, mode);
    assert.equal(h.stage(run.id).launchUncertain, true, mode);
    assert.equal(h.effects.filter((effect) => effect[0] === "hc" && effect[1][0] === "run").length, 1, mode);
  }
});

test("ambiguous start remains recoverable and never permits an immediate retry", async () => {
  const h = harness(), run = h.create();
  h.controls.run = (terminal, list) => { list.set(terminal.address, terminal); throw new Error("timeout"); };
  h.controls.ls = () => { throw new Error("offline"); };
  await assert.rejects(h.runtime.launch(run.id), /timeout/);
  assert.equal(h.stage(run.id).launchUncertain, true);
  await assert.rejects(h.runtime.launch(run.id));
  h.controls.ls = null;
  await h.runtime.refresh(run.id);
  assert.equal(h.stage(run.id).terminal, "t1");
  assert.equal(h.stage(run.id).launchUncertain, false);
  assert.equal(h.terminals.size, 1);
});

test("an idle startup and even a ready report do not trigger automatic handoff", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id); h.ready(run.id);
  await h.runtime.refresh(run.id, { autoAdvance: true });
  assert.equal(h.stage(run.id).id, "plan");
  assert.equal(h.stage(run.id).status, "ready");
  assert.equal(h.terminals.size, 1);
});

test("automatic mode requires a current report and an observed completed turn", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id);
  h.terminals.get("t1").status.state = "working";
  await h.runtime.refresh(run.id, { autoAdvance: true });
  h.ready(run.id);
  h.terminals.get("t1").status.state = "idle"; h.terminals.get("t1").turn = 1;
  await h.runtime.refresh(run.id, { autoAdvance: true });
  assert.equal(h.stage(run.id).id, "implement");
  assert.equal(h.current(run.id).stages[0].status, "completed");
  assert.equal(h.terminals.size, 2);
});

test("a task completed before its first get advances once, including a recovered late reply", async () => {
  for (const lateReply of [false, true]) {
    const h = harness(), run = h.create({ autoAdvance: true });
    h.controls.run = (terminal, list) => {
      terminal.status = { state: "idle" }; terminal.turn = 1;
      list.set(terminal.address, terminal);
      if (lateReply) throw new Error("late run response");
      return okay(compactTerminal(terminal));
    };
    await h.runtime.launch(run.id);
    assert.equal(h.stage(run.id).sawWorking, true);
    assert.equal(h.stage(run.id).lastTurn, 1);
    h.controls.run = null;
    h.ready(run.id);
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.current(run.id).stages[0].status, "completed");
    assert.equal(h.stage(run.id).id, "implement");
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.terminals.size, 2, "repeated polling neither duplicates the first task nor skips the next");
  }
});

test("older saved running and ready attempts recover completed work even when lastTurn already equals one", async () => {
  for (const savedStatus of ["running", "ready"]) {
    const h = harness(), run = h.create({ autoAdvance: true });
    const state = h.host.shared(STATE_KEY), saved = state.runs[0], stage = saved.stages[0];
    saved.status = "running";
    Object.assign(stage, { status: "running", attempt: 1, launchKey: run.id + "-plan-1", terminal: "t37",
      startedAt: 10000, terminalState: "idle", sawWorking: false, lastTurn: 1 });
    h.data.set(STATE_KEY, state);
    const report = h.ready(run.id);
    if (savedStatus === "ready") { stage.status = "ready"; stage.report = report; }
    h.terminals.set("t37", { address: "t37", labels: { "aihub.run": run.id, "aihub.stage": "plan", "aihub.attempt": "1" },
      state: "live", status: { state: "idle" }, turn: 1, exit_code: null, reason: null });
    const reopened = createRuntime(h.host);
    await reopened.refresh(run.id);
    assert.equal(h.stage(run.id).status, "ready");
    assert.equal(h.stage(run.id).sawWorking, true);
    assert.equal(h.terminals.size, 1, "reopening and inspecting a saved run does not arm it");
    await reopened.refresh(run.id, { autoAdvance: true });
    assert.equal(h.current(run.id).stages[0].status, "completed", savedStatus);
    assert.equal(h.current(run.id).stages[0].terminal, "t37", "the previous attempt identity remains intact");
    assert.equal(h.stage(run.id).id, "implement", savedStatus);
    assert.equal(h.effects.filter((effect) => effect[0] === "hc" && effect[1][0] === "run").length, 1, "only the next role launches");
  }
});

test("all four automatic roles wait for report writers to finish without disarming or duplicating work", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id);
  for (const [index, role] of ["plan", "implement", "review", "verify"].entries()) {
    const stage = h.stage(run.id), terminal = h.terminals.get(stage.terminal);
    assert.equal(stage.id, role);
    terminal.status.state = "working";
    h.ready(run.id);
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.stage(run.id).status, "ready");
    assert.equal(h.current(run.id).autoAdvance, true, "a report written during the final turn keeps automatic mode enabled");
    assert.equal(h.terminals.size, index + 1, "no next role starts while the report writer is working");
    await assert.rejects(h.runtime.advance(run.id), /작업 중/, "manual handoff still refuses a working AI");
    terminal.status.state = "idle"; terminal.turn = 1;
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.current(run.id).stages[index].status, "completed");
  }
  assert.equal(h.current(run.id).status, "completed");
  assert.equal(h.current(run.id).autoAdvance, false);
  assert.equal(h.effects.filter((effect) => effect[0] === "hc" && effect[1][0] === "run").length, 4);
});

test("a completed turn ending in approval waiting still pauses automatic handoff", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  h.controls.run = (terminal, list) => {
    terminal.status = { state: "blocked", kind: "permission" }; terminal.turn = 1;
    list.set(terminal.address, terminal);
    return okay(compactTerminal(terminal));
  };
  await h.runtime.launch(run.id); h.ready(run.id);
  await h.runtime.refresh(run.id, { autoAdvance: true });
  assert.equal(h.current(run.id).autoAdvance, false);
  assert.equal(h.stage(run.id).id, "plan");
  assert.equal(h.terminals.size, 1);
  assert.equal(h.effects.some((effect) => effect[0] === "hc" && ["send", "keys"].includes(effect[1][0])), false);
});

test("reopening a team does not arm automatic execution", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id); h.ready(run.id);
  h.terminals.get("t1").turn = 1;
  const reopened = createRuntime(h.host);
  await reopened.refresh(run.id);
  assert.equal(h.terminals.size, 1);
  assert.equal(h.stage(run.id).status, "ready");
});

test("failed checks or unresolved issues pause automatic mode with the report retained", async () => {
  for (const override of [{ tests: [{ command: "npm test", result: "fail", detail: "one failure" }] }, { issues: ["확인이 필요한 오류"] }, { status: "blocked", issues: ["로그인 필요"] }]) {
    const h = harness(), run = h.create({ autoAdvance: true });
    await h.runtime.launch(run.id); h.ready(run.id, override); h.terminals.get("t1").turn = 1;
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.current(run.id).autoAdvance, false);
    assert.equal(h.stage(run.id).status, "ready");
    assert.ok(h.stage(run.id).report);
    assert.equal(h.terminals.size, 1);
  }
});

test("partial, wrong-task, and stale-attempt reports cannot advance work", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id);
  const file = reportFile(h.current(run.id), h.stage(run.id));
  for (const raw of ["{", JSON.stringify(h.ready(run.id, { runId: "other-run" })), JSON.stringify(h.ready(run.id, { attempt: 99 }))]) {
    h.files.set(file, raw); await h.runtime.collect(run.id);
    assert.equal(h.stage(run.id).status, "running");
    assert.equal(h.stage(run.id).report, null);
    assert.ok(h.stage(run.id).reportError);
  }
});

test("retry uses a new brief/report path and preserves the prior attempt", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id);
  const first = h.stage(run.id), firstFile = reportFile(h.current(run.id), first);
  h.ready(run.id);
  h.terminals.get("t1").state = "finished"; h.terminals.get("t1").exit_code = 1; h.terminals.get("t1").reason = "exited";
  await h.runtime.refresh(run.id);
  assert.equal(h.stage(run.id).status, "error");
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).attempt, 2);
  assert.notEqual(reportFile(h.current(run.id), h.stage(run.id)), firstFile);
  assert.ok(h.files.has(firstFile));
  await h.runtime.collect(run.id);
  assert.equal(h.stage(run.id).report, null);
});

test("repeated retry cannot forget an earlier attempt that is still working", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id);
  await h.runtime.interrupt(run.id);
  h.terminals.get("t1").status.state = "working";
  const previous = clone(h.stage(run.id)), filesBefore = h.files.size;
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(h.runtime.launch(run.id), /이전 시도의 AI가 아직 실행 중/);
    assert.deepEqual(h.stage(run.id), previous, "a refused retry retains the original terminal and attempt");
    assert.equal(h.files.size, filesBefore, "a refused retry does not prepare another attempt");
  }
  assert.equal(h.effects.filter((e) => e[0] === "hc" && e[1][0] === "run").length, 1);
  h.terminals.get("t1").status.state = "idle";
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).attempt, previous.attempt + 1);
  assert.equal(h.stage(run.id).terminal, "t2");
});

test("failed prior-terminal inspection preserves its identity across repeated retries", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id);
  await h.runtime.interrupt(run.id);
  const previous = clone(h.stage(run.id));
  for (const failure of [
    () => { throw new Error("core offline"); },
    () => ({ code: 1, stdout: "", stderr: "core offline" }),
  ]) {
    h.controls.get = failure;
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(h.runtime.launch(run.id), /core offline/);
      assert.deepEqual(h.stage(run.id), previous, "a disconnected core does not erase the prior attempt");
    }
  }
  assert.equal(h.effects.filter((e) => e[0] === "hc" && e[1][0] === "run").length, 1);
  h.controls.get = null;
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).attempt, previous.attempt + 1);
  assert.equal(h.stage(run.id).terminal, "t2");
});

test("permissions or auth waiting pauses the workflow and does not send an answer", async () => {
  const h = harness(), run = h.create({ autoAdvance: true }); await h.runtime.launch(run.id);
  h.terminals.get("t1").status = { state: "blocked", kind: "permission" };
  await h.runtime.refresh(run.id, { autoAdvance: true });
  assert.equal(h.current(run.id).status, "paused");
  assert.equal(h.current(run.id).autoAdvance, false);
  assert.ok(!h.effects.some((e) => e[0] === "hc" && ["send", "keys"].includes(e[1][0])));
});

test("manual handoff cannot start the next role while the current AI is working", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id); h.ready(run.id); await h.runtime.collect(run.id);
  h.terminals.get("t1").status.state = "working";
  await assert.rejects(h.runtime.advance(run.id), /작업 중/);
  assert.equal(h.terminals.size, 1);
});

test("a lost or nonzero-exit terminal is never declared successful", async () => {
  for (const change of [{ state: "finished", exit_code: 2, reason: "exited" }, { state: "live", reason: "holder_lost" }]) {
    const h = harness(), run = h.create({ autoAdvance: true }); await h.runtime.launch(run.id); h.ready(run.id);
    Object.assign(h.terminals.get("t1"), change);
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.current(run.id).status, "error");
    assert.equal(h.stage(run.id).status, "error");
    assert.equal(h.terminals.size, 1);
  }
});

test("interrupt only targets an owned attempt and reports uncertainty honestly", async () => {
  const h = harness(), run = h.create(); await h.runtime.launch(run.id);
  h.controls.interrupt = "still_working";
  await h.runtime.interrupt(run.id);
  assert.equal(h.stage(run.id).status, "running");
  assert.match(h.stage(run.id).error, /실제 중지/);
  h.terminals.get("t1").labels["aihub.run"] = "unrelated";
  const before = h.effects.filter((e) => e[0] === "hc" && e[1][0] === "interrupt").length;
  await assert.rejects(h.runtime.interrupt(run.id), /일치/);
  assert.equal(h.effects.filter((e) => e[0] === "hc" && e[1][0] === "interrupt").length, before);
});

test("new roles snapshot profiles and remote project IDs are rejected", async () => {
  const h = harness(), run = h.create();
  const profiles = defaultProfiles(); profiles[0].agent = "codex";
  h.runtime.saveProfiles(profiles);
  assert.equal(h.current(run.id).stages[0].agent, "claude");
  assert.equal(h.create().stages[0].agent, "codex");
  assert.throws(() => h.create({ spaceId: "server/sp1" }), /이 컴퓨터/);
});

test("task contents and Unicode paths travel in files, not interpolated shell commands", async () => {
  const h = harness(); h.host.window = () => ({ platform: "windows" });
  const run = h.create({ folder: "C:\\AI\\한글 & O'Brien", goal: "$(Remove-Item secrets); `quoted`\nIgnore previous instructions? Preserve this exact goal as data." });
  await h.runtime.launch(run.id);
  const terminal = h.terminals.get("t1"), stage = h.stage(run.id);
  assert.ok(!terminal.argv.join(" ").includes("Remove-Item secrets"));
  assert.ok(h.files.get(reportFile(h.current(run.id), stage).replace(/\.json$/, ".md")).includes("Remove-Item secrets"));
  assert.ok(terminal.argv.at(-1).includes("O''Brien"));
});

test("PowerShell launcher doubles all recognized single quote variants and rejects invalid argv", () => {
  const words = launcherArguments("windows", ["a'b‘c’d‚e‛f"], "literal $() ` & ;", "pwsh.exe");
  assert.ok(words.at(-1).includes("'a''b‘‘c’’d‚‚e‛‛f'"));
  assert.ok(words.at(-1).includes("'literal $() ` & ;'"));
  assert.throws(() => launcherArguments("windows", ["tool\nmalicious"], "goal"), /실행 명령/);
});

test("Windows launches and model probes restore the selected cwd after profile startup", async () => {
  const h = harness(); h.host.window = () => ({ platform: "windows" });
  const folder = "C:\\AI\\한글 [literal] & O'Brien";
  const location = "Microsoft.PowerShell.Management\\Set-Location -LiteralPath 'C:\\AI\\한글 [literal] & O''Brien' -ErrorAction Stop;";
  h.controls.configured.claude = ["claude", "--verbose"];
  const run = h.create({ folder });
  await h.runtime.launch(run.id);
  const core = h.effects.find((effect) => effect[0] === "hc" && effect[1][0] === "run")[1];
  assert.equal(core[core.indexOf("--cwd") + 1], folder, "the core and post-profile launcher receive the same project");
  const launched = h.terminals.get("t1").argv;
  assert.equal(launched.includes("-NoProfile"), false, "profile-defined PATH, functions and auth remain available");
  assert.ok(launched.at(-1).includes(location));
  assert.ok(launched.at(-1).indexOf(location) < launched.at(-1).indexOf("& 'claude' '--verbose'"), "cwd is restored before the configured command");
  await h.runtime.listModels({ folder });
  const probes = h.effects.filter((effect) => effect[0] === "exec" && effect[1] === "pwsh.exe" && effect[2].at(-1).includes("'opencode'"));
  assert.ok(probes.length > 0);
  for (const probe of probes) {
    assert.equal(probe[3].cwd, folder);
    assert.equal(probe[2].includes("-NoProfile"), false);
    assert.ok(probe[2].at(-1).includes(location), "captured queries use the selected project after profiles too");
    assert.ok(probe[2].at(-1).indexOf(location) < probe[2].at(-1).indexOf("& 'opencode'"));
  }
});

test("Windows cwd helpers reject invalid paths and retain omitted-cwd and Unix behavior", () => {
  const capture = (cwd) => capturedArguments(["tool"], "powershell.exe", cwd);
  const launch = (cwd) => launcherArguments("windows", ["tool"], undefined, "powershell.exe", {}, cwd);
  for (const cwd of [null, "", "relative", "C:relative", "C:\\work\\..\\other", "C:\\bad\nfolder", "C:\\bad\u007ffolder", "C:\\" + "x".repeat(LIMITS.path)]) {
    assert.throws(() => capture(cwd), /프로젝트|폴더|경로/);
    assert.throws(() => launch(cwd), /프로젝트|폴더|경로/);
  }
  assert.doesNotMatch(capture().at(-1), /Set-Location/, "omitting cwd preserves the caller's original shell behavior");
  assert.doesNotMatch(launch().at(-1), /Set-Location/);
  assert.deepEqual(launcherArguments("linux", ["tool"], undefined, "/bin/sh", {}, "/explicit/project"),
    launcherArguments("linux", ["tool"], undefined, "/bin/sh"), "non-Windows launcher behavior is unchanged");
});

test("real Unix launcher preserves literal arguments without executing their contents", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "aihub-argv-"));
  try {
    const marker = join(directory, "must-not-exist");
    const task = "한글 O'Brien ‘quote’ ; $(touch " + marker + ") & `echo bad`";
    const args = launcherArguments("linux", [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))"], task, "/bin/sh");
    const output = spawnSync(args[0], args.slice(1), { input: "", encoding: "utf8", timeout: 10000 });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual(JSON.parse(output.stdout.trim()), [task]);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("archive persists a complete run before removing it from the recent list", async () => {
  const h = harness(), run = h.create();
  const file = await h.runtime.archive(run.id);
  assert.equal(JSON.parse(h.files.get(file)).id, run.id);
  assert.equal(h.runtime.getState().runs.length, 0);
  assert.equal(h.runtime.getState().selectedRunId, null);
  const live = h.create(); await h.runtime.launch(live.id);
  await assert.rejects(h.runtime.archive(live.id), /실행 중/);
  assert.equal(h.runtime.getState().runs.length, 1);
});

test("recent-history limit refuses new work instead of silently dropping records", () => {
  const h = harness();
  for (let i = 0; i < LIMITS.runs; i++) h.create();
  assert.throws(() => h.create(), /기록/);
  assert.equal(h.data.get(STATE_KEY).runs.length, LIMITS.runs);
});

test("another panel's refresh cannot fail a launch still preparing its brief", async () => {
  const h = harness(), run = h.create();
  let release;
  h.host.knownAgents = () => new Promise((resolve) => { release = () => resolve([{ key: "claude", installed: true, run: ["claude"] }]); });
  const pending = h.runtime.launch(run.id);
  try {
    await createRuntime(h.host).refresh(run.id);
    assert.equal(h.stage(run.id).status, "launching");
    assert.ok(!h.stage(run.id).launchUncertain);
  } finally { release(); await pending; }
  assert.equal(h.stage(run.id).status, "running");
  assert.equal(h.terminals.size, 1);
});

test("a transport failure and an empty list do not authorize a duplicate attempt", async () => {
  const h = harness(), run = h.create();
  let late;
  h.controls.run = (terminal) => { late = terminal; throw new Error("network timeout before reply"); };
  await assert.rejects(h.runtime.launch(run.id), /timeout/);
  assert.equal(h.stage(run.id).status, "launching");
  assert.equal(h.stage(run.id).launchUncertain, true);
  await h.runtime.refresh(run.id);
  await assert.rejects(h.runtime.launch(run.id));
  h.terminals.set(late.address, late);
  await h.runtime.refresh(run.id);
  assert.equal(h.stage(run.id).status, "running");
  assert.equal(h.stage(run.id).attempt, 1);
  assert.equal(h.effects.filter((e) => e[0] === "hc" && e[1][0] === "run").length, 1);
});

test("deleting or partly overwriting a collected report prevents stale handoff", async () => {
  for (const replacement of [null, "", "{"]) {
    const h = harness(), run = h.create({ autoAdvance: true });
    await h.runtime.launch(run.id); h.ready(run.id); await h.runtime.collect(run.id);
    const file = reportFile(h.current(run.id), h.stage(run.id));
    if (replacement === null) h.files.delete(file); else h.files.set(file, replacement);
    h.terminals.get("t1").turn = 1;
    await h.runtime.refresh(run.id, { autoAdvance: true });
    assert.equal(h.terminals.size, 1);
    assert.equal(h.stage(run.id).id, "plan");
    assert.ok(h.stage(run.id).reportError);
    await assert.rejects(h.runtime.advance(run.id));
  }
});

test("pausing while automatic handoff awaits core facts stops the next launch", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id); h.ready(run.id); h.terminals.get("t1").turn = 1;
  let count = 0, release, entered;
  const barrier = new Promise((resolve) => { entered = resolve; });
  h.controls.get = () => {
    if (++count !== 2) return okay(h.terminals.get("t1"));
    entered(); return new Promise((resolve) => { release = () => resolve(okay(h.terminals.get("t1"))); });
  };
  const pending = h.runtime.refresh(run.id, { autoAdvance: true });
  await barrier; h.runtime.pause(run.id); release(); await pending;
  assert.equal(h.terminals.size, 1);
  assert.equal(h.stage(run.id).id, "plan");
  assert.equal(h.current(run.id).autoAdvance, false);
});

test("pausing during the next role's setup cancels preparation before its CLI starts", async () => {
  const h = harness(), run = h.create({ autoAdvance: true });
  await h.runtime.launch(run.id); h.ready(run.id); h.terminals.get("t1").turn = 1;
  let release, entered;
  const barrier = new Promise((resolve) => { entered = resolve; });
  const known = h.host.knownAgents;
  let waiting = true;
  h.host.knownAgents = () => {
    if (!waiting) return known();
    waiting = false; entered();
    return new Promise((resolve) => { release = () => resolve([{ key: "opencode", installed: true, run: ["opencode"] }]); });
  };
  const pending = h.runtime.refresh(run.id, { autoAdvance: true });
  await barrier; h.runtime.pause(run.id); release(); await pending;
  assert.equal(h.terminals.size, 1);
  assert.equal(h.stage(run.id).id, "implement");
  assert.equal(h.stage(run.id).status, "stopped");
});

const openCodeRun = (h) => h.create({ profiles: defaultProfiles().map((p) => ({ ...p, enabled: p.id === "implement" })) });
const oneRole = (h, agent, model, effort) => h.create({ profiles: [{ id: "work", name: "담당", agent, model, effort, access: "write", enabled: true, instructions: "승인된 한 가지 일을 수행하고 보고하세요." }] });
const modelCache = (id = "gpt-6.2-sol", efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]) => JSON.stringify({
  fetched_at: "2026-11-24T12:00:00Z", client_version: "0.test", models: [{ slug: id, display_name: "로컬 모델", visibility: "list",
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })) }],
});
const goModel = "opencode-go/deepseek-v4.1-flash";
function apiCatalog(h, efforts = ["low", "high"]) {
  h.controls.apiHelp = "  --param <key=value>  OpenAPI query parameter\n";
  h.controls.metadata = { location: { directory: "/work/project" }, data: [{ providerID: "opencode-go", id: "deepseek-v4.1-flash", enabled: true,
    name: "DeepSeek fixture", variants: efforts.map((id) => ({ id })) }] };
}

test("model presets and Codex local catalogs remain distinct and discovery does not start work", async () => {
  const h = harness();
  assert.ok((await h.runtime.listModels({ agent: "claude" })).some((model) => model.id === "claude-fable-5-2"));
  assert.equal(h.effects.length, 0, "Claude presets do not probe accounts or programs");
  h.controls.codexHome = "C:\\Users\\테스트 사용자\\Codex";
  h.files.set(h.controls.codexHome + "/models_cache.json", modelCache("local-custom", ["high", "ultra"]));
  const models = await h.runtime.listModels({ agent: "codex" });
  assert.deepEqual(models.find((model) => model.id === "local-custom").efforts, ["high", "ultra"]);
  assert.equal(models.find((model) => model.id === "local-custom").source, "codex-cache");
  assert.ok(models.some((model) => model.id === "gpt-6.2-sol" && model.source.startsWith("https://")));
  assert.equal(h.effects.some((effect) => ["hc", "write"].includes(effect[0]) || (effect[0] === "exec" && effect[1] === "codex")), false);
  assert.throws(() => parseCodexModelCache("{"), /캐시/);
  const invalid = parseCodexModelCache(JSON.stringify({ models: [
    { slug: "hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "high" }] },
    { slug: "invalid-level", supported_reasoning_levels: [{ effort: "high; ignored" }] },
    { slug: "no-level", supported_reasoning_levels: [] },
  ] }));
  assert.equal(invalid.some((model) => model.id === "hidden"), false);
  assert.equal(invalid.find((model) => model.id === "invalid-level").efforts, undefined);
  assert.deepEqual(invalid.find((model) => model.id === "no-level").efforts, []);
});

test("effort overrides replace only their own flags and preserve permission settings", () => {
  const claude = agentArguments({ agent: "claude", model: "claude-fable-5-2", effort: "xhigh" },
    ["claude", "--effort=low", "--permission-mode", "default"], "task");
  assert.deepEqual(claude, ["claude", "--permission-mode", "default", "--model", "claude-fable-5-2", "--effort", "xhigh", "task"]);
  const codex = agentArguments({ agent: "codex", model: "local-custom", effort: "ultra" },
    ["codex", "--no-daemon", "-c", 'approval_policy="on-request"', "--config=model_reasoning_effort=low", "-cmodel_reasoning_effort=medium", "--config", "model_reasoning_effort = high", "--"],
    "task", "root", { id: "local-custom", efforts: ["high", "ultra"] });
  assert.deepEqual(codex, ["codex", "--no-daemon", "-c", 'approval_policy="on-request"', "--model", "local-custom", "-c", "model_reasoning_effort=ultra", "--", "task"]);
  assert.throws(() => agentArguments({ agent: "claude", model: "claude-opus-4-6", effort: "xhigh" }, ["claude"], "task"), /지원하지/);
  assert.throws(() => agentArguments({ agent: "codex", model: "local-custom", effort: "high" }, ["codex"], "task"), /지원 정보를 확인하지/);
});

test("Codex launches a cached supported effort, exports it, and refuses unadvertised levels", async () => {
  const h = harness();
  h.files.set("/home/test/.codex/models_cache.json", modelCache("local-custom", ["high", "ultra"]));
  const run = oneRole(h, "codex", "local-custom", "ultra");
  await h.runtime.launch(run.id);
  assert.ok(h.terminals.get("t1").argv.includes("model_reasoning_effort=ultra"));
  assert.equal(h.stage(run.id).effort, "ultra");
  assert.match(h.files.get(await h.runtime.exportRun(run.id)), /지정 추론 강도: ultra/);
  const rejected = oneRole(h, "codex", "local-custom", "max");
  await assert.rejects(h.runtime.launch(rejected.id), /지원하지/);
  assert.equal(h.terminals.size, 1);
  assert.equal(h.stage(rejected.id).effort, "max");
});

test("Claude selected effort reaches both CLI and child environment, and unsupported help fails closed", async () => {
  for (const platform of ["linux", "windows"]) {
    const h = harness(); h.host.window = () => ({ platform });
    const run = oneRole(h, "claude", "claude-fable-5-2", "xhigh");
    await h.runtime.launch(run.id);
    const argv = h.terminals.get("t1").argv;
    if (platform === "windows") {
      assert.match(argv.at(-1), /\$env:CLAUDE_CODE_EFFORT_LEVEL = 'xhigh'/);
      assert.match(argv.at(-1), /'--effort' 'xhigh'/);
      assert.match(argv.at(-1), /finally \{ \$env:CLAUDE_CODE_EFFORT_LEVEL = \$ai_hub_env_0/);
    } else {
      assert.ok(argv.includes("CLAUDE_CODE_EFFORT_LEVEL=xhigh"));
      assert.equal(argv[argv.indexOf("--effort") + 1], "xhigh");
    }
  }
  const h = harness(), run = oneRole(h, "claude", "claude-fable-5-2", "high");
  h.controls.claudeHelp = "  --model <model>\n";
  await assert.rejects(h.runtime.launch(run.id), /옵션을 확인하지 못/);
  assert.equal(h.terminals.size, 0);
  assert.equal(h.stage(run.id).effort, "high");
});

test("OpenCode project API metadata supplies exact variants without substituting provider IDs", async () => {
  const h = harness(); apiCatalog(h);
  h.controls.configured.opencode = ["opencode", "--server", "http://localhost:4096"];
  const models = await h.runtime.listModels({ folder: "/work/project" });
  assert.deepEqual(models.find((model) => model.id === goModel).efforts, ["low", "high"]);
  assert.equal(models.find((model) => model.id === "opencode/deepseek-v4.1-flash").efforts, undefined);
  const query = h.effects.find((effect) => effect[0] === "exec" && effect[2]?.[0] === "api" && effect[2]?.[1] === "model.list");
  assert.deepEqual(query[2], ["api", "model.list", "--param", "location[directory]=/work/project", "--server", "http://localhost:4096"]);
  assert.equal(query[3].cwd, "/work/project");
  assert.equal(h.effects.some((effect) => ["hc", "write"].includes(effect[0])), false);
});

test("OpenCode v2 uses a validated model#variant in mini and leaves no conflicting variant flag", async () => {
  for (const platform of ["linux", "windows"]) {
    const h = harness(); apiCatalog(h); h.host.window = () => ({ platform });
    h.controls.rootHelp = "  --prompt <text>\n";
    h.controls.configured.opencode = ["opencode", "--variant", "old", "--agent", "build"];
    const run = oneRole(h, "opencode", goModel, "high");
    await h.runtime.launch(run.id);
    const argv = h.terminals.get("t1").argv;
    if (platform === "windows") {
      assert.match(argv.at(-1), /'opencode' 'mini'/);
      assert.match(argv.at(-1), /'--model' 'opencode-go\/deepseek-v4\.1-flash#high'/);
      assert.doesNotMatch(argv.at(-1), /'--variant'/);
    } else {
      assert.equal(argv[argv.indexOf("opencode") + 1], "mini");
      assert.equal(argv[argv.indexOf("--model") + 1], goModel + "#high");
      assert.equal(argv.includes("--variant"), false);
    }
    assert.equal(h.stage(run.id).model, goModel, "the stored model and effort stay separate");
    assert.equal(h.stage(run.id).effort, "high");
  }
});

test("OpenCode v1 uses --variant only when its configured mode advertises it", async () => {
  const verbose = goModel + "\n" + JSON.stringify({ name: "DeepSeek fixture", variants: { low: {}, high: {}, disabled: { disabled: true } } }, null, 2) + "\n";
  const capability = parseOpenCodeModelMetadata(verbose, "verbose")[0];
  assert.deepEqual(capability.efforts, ["low", "high"]);
  for (const explicitRun of [true, false]) {
    const h = harness(); h.controls.modelsHelp = "  --verbose  include metadata\n"; h.controls.verboseModels = verbose;
    h.controls.miniHelp = "unknown command mini";
    const run = oneRole(h, "opencode", goModel, "high");
    if (explicitRun) {
      h.controls.configured.opencode = ["opencode", "run"];
      h.controls.runHelp = "  --model <model>\n  --variant <variant>\n";
      await h.runtime.launch(run.id);
      const argv = h.terminals.get("t1").argv;
      assert.equal(argv[argv.indexOf("--variant") + 1], "high");
      assert.equal(argv[argv.indexOf("--model") + 1], goModel);
    } else {
      await assert.rejects(h.runtime.launch(run.id), /추론 강도 옵션/);
      assert.equal(h.terminals.size, 0, "an interactive root is never silently replaced by noninteractive run");
    }
  }
});

test("missing, malformed, or wrong-project variants never silently lower a requested effort", async () => {
  for (const scenario of ["missing", "wrong-project", "malformed", "unsupported"]) {
    const h = harness();
    if (scenario !== "missing") apiCatalog(h, scenario === "unsupported" ? ["low"] : ["high"]);
    if (scenario === "wrong-project") h.controls.metadata.location.directory = "/different/project";
    if (scenario === "malformed") h.controls.metadata.data[0].variants = [{ id: "high; ignored" }];
    const run = oneRole(h, "opencode", goModel, "high");
    await assert.rejects(h.runtime.launch(run.id), /지원 정보|지원하지/, scenario);
    assert.equal(h.terminals.size, 0, scenario);
    assert.equal(h.stage(run.id).effort, "high", scenario);
    assert.equal(h.stage(run.id).model, goModel, scenario);
  }
});

test("Unix launch environment overrides an inherited effort only for the selected CLI", { skip: process.platform === "win32" }, () => {
  const selected = launcherArguments("linux", [process.execPath, "-e", "console.log(process.env.CLAUDE_CODE_EFFORT_LEVEL)"], undefined, "/bin/sh", { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" });
  const output = spawnSync(selected[0], selected.slice(1), { encoding: "utf8", input: 'printf "%s\\n" "$CLAUDE_CODE_EFFORT_LEVEL"\nexit\n', env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: "low" }, timeout: 15000 });
  assert.equal(output.status, 0, output.stderr || String(output.error));
  assert.deepEqual(output.stdout.trim().split(/\r?\n/), ["xhigh", "low"], "the shell after the CLI retains its original environment");
});

test("OpenCode model lists use exact provider IDs and ignore logs or malformed entries", () => {
  const models = parseModelList("\u001b[32mModels cache refreshed\u001b[0m\r\nopencode-go/deepseek-v4.1-flash\nopencode/deepseek-v4.1-flash\nopencode-go/deepseek-v4.1-flash\nhttps://not-a-model\n--model p/x\n");
  assert.deepEqual(models.map((m) => m.id).sort(), ["opencode-go/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash"].sort());
  assert.throws(() => parseModelList("Error: provider not configured"), /모델 목록/);
  assert.throws(() => parseModelList("x".repeat(1000001)), /너무 크/);
});

test("model discovery uses the selected local project without model calls or version-specific refresh flags", async () => {
  const h = harness();
  const models = await h.runtime.listModels({ agent: "opencode", folder: "C:\\AI\\한글 프로젝트", refresh: true });
  assert.ok(models.some((m) => m.id === "opencode-go/deepseek-v4.1-flash"));
  const query = h.effects.find((e) => e[0] === "exec" && e[1] === "opencode");
  assert.deepEqual(query[2], ["models"]);
  assert.equal(query[3].cwd, "C:\\AI\\한글 프로젝트");
  assert.equal(h.effects.some((e) => e[0] === "hc" || e[0] === "write"), false);
  assert.ok((await h.runtime.listModels({ agent: "codex" })).some((entry) => entry.id === "gpt-6.2-sol"), "Codex offers documented presets when its local cache is absent");
  h.controls.installed = ["claude", "codex"];
  await assert.rejects(h.runtime.listModels(), /설치/);
});

test("explicit models replace configured flags without altering unrelated CLI options", () => {
  const model = "opencode-go/deepseek-v4.1-flash";
  assert.deepEqual(agentArguments({ agent: "opencode", model }, ["opencode", "--model", "old/model", "--agent", "build", "-m=other/model", "--prompt", "old task"], "new task"),
    ["opencode", "--agent", "build", "--model", model, "--prompt", "new task"]);
  assert.deepEqual(agentArguments({ agent: "codex", model: "chosen-codex" }, ["codex", "--no-daemon", "-mold", "--"], "task"),
    ["codex", "--no-daemon", "--model", "chosen-codex", "--", "task"]);
  assert.deepEqual(agentArguments({ agent: "claude", model: "fable" }, ["claude", "--model=old", "--effort", "high"], "task"),
    ["claude", "--effort", "high", "--model", "fable", "task"]);
  assert.deepEqual(agentArguments({ agent: "codex", model: "" }, ["codex", "--model", "configured"], "task"),
    ["codex", "--model", "configured", "task"]);
  assert.throws(() => agentArguments({ agent: "opencode", model: "deepseek-v4.1-flash" }, ["opencode"], "task"), /provider\/model/);
  assert.throws(() => agentArguments({ agent: "other-tool", model: "unknown" }, ["other-tool"], "task"), /지원하지/);
  assert.throws(() => agentArguments({ agent: "claude", model: "fable;touch bad" }, ["claude"], "task"), /올바르지/);
});

test("OpenCode v1 launches the exact Go model with an explicit prompt flag", async () => {
  const h = harness(), run = openCodeRun(h);
  await h.runtime.launch(run.id);
  const argv = h.terminals.get("t1").argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "opencode-go/deepseek-v4.1-flash");
  assert.ok(argv[argv.indexOf("--prompt") + 1].includes("AI Hub 팀 작업"));
  assert.equal(argv.includes("mini"), false);
  assert.equal(argv.includes("--auto"), false);
  assert.equal(argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(h.stage(run.id).model, "opencode-go/deepseek-v4.1-flash");
});

test("OpenCode v2 uses supported mini flags when root cannot accept a model", async () => {
  const h = harness(), run = openCodeRun(h);
  h.controls.rootHelp = "  --prompt <text>\n  --continue\n";
  await h.runtime.launch(run.id);
  const argv = h.terminals.get("t1").argv;
  assert.equal(argv[argv.indexOf("opencode") + 1], "mini");
  assert.equal(argv[argv.indexOf("--model") + 1], "opencode-go/deepseek-v4.1-flash");
  assert.ok(argv[argv.indexOf("--prompt") + 1].includes("AI Hub 팀 작업"));
  assert.ok(h.effects.some((e) => e[0] === "exec" && e[1] === "opencode" && e[2].join(" ") === "mini --help"));
});

test("a selected OpenCode model is never silently replaced by a different provider or CLI default", async () => {
  const h = harness(), run = openCodeRun(h);
  h.controls.models = "opencode/deepseek-v4.1-flash\n";
  await assert.rejects(h.runtime.launch(run.id), /모델 목록에 없습니다/);
  assert.equal(h.terminals.size, 0);
  assert.equal(h.stage(run.id).model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(h.stage(run.id).status, "error");
});

test("unsupported OpenCode prompt/model flags stop before launching an AI", async () => {
  const h = harness(), run = openCodeRun(h);
  h.controls.rootHelp = "Usage: opencode [directory]\n";
  h.controls.miniHelp = "unknown command mini\n";
  await assert.rejects(h.runtime.launch(run.id), /옵션을 확인하지 못/);
  assert.equal(h.terminals.size, 0);
  assert.equal(h.stage(run.id).status, "error");
});

test("OpenCode model lookup failure preserves the selected assignment and reports the problem", async () => {
  const h = harness(), run = openCodeRun(h);
  h.controls.exec = () => ({ code: 1, stdout: "", stderr: "provider unavailable" });
  await assert.rejects(h.runtime.launch(run.id), /provider unavailable/);
  assert.equal(h.stage(run.id).model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(h.terminals.size, 0);
});

test("custom role ordering, tool, model and access survive creation and exported records", async () => {
  const h = harness();
  const profiles = [
    { id: "build-first", name: "만들기", agent: "codex", model: "chosen-codex", access: "write", enabled: true, instructions: "요청 범위를 구현하세요." },
    { id: "audit-after", name: "검사하기", agent: "claude", model: "fable", access: "read", enabled: true, instructions: "변경을 검토하세요." },
  ];
  h.runtime.saveProfiles(profiles);
  const run = h.create();
  await h.runtime.launch(run.id);
  assert.equal(h.stage(run.id).id, "build-first");
  assert.equal(h.terminals.get("t1").argv[h.terminals.get("t1").argv.indexOf("--model") + 1], "chosen-codex");
  h.ready(run.id); await h.runtime.collect(run.id); await h.runtime.advance(run.id);
  assert.equal(h.stage(run.id).id, "audit-after");
  assert.equal(h.stage(run.id).access, "read");
  assert.equal(h.terminals.get("t2").argv[h.terminals.get("t2").argv.indexOf("--model") + 1], "fable");
  const path = await h.runtime.exportRun(run.id);
  assert.match(h.files.get(path), /지정 모델: chosen-codex/);
  assert.match(h.files.get(path), /지정 모델: fable/);
});

test("OpenCode refuses ambiguous wrappers and project arguments before any subprocess starts", async () => {
  for (const configured of [["npx", "opencode-ai"], ["opencode", "--log-level", "DEBUG", "mini"], ["opencode", "/another/project"]]) {
    const h = harness(), run = openCodeRun(h);
    h.controls.configured.opencode = configured;
    await assert.rejects(h.runtime.launch(run.id), /래퍼|바로 뒤|위치 인자/);
    assert.equal(h.effects.some((e) => e[0] === "exec" || e[0] === "hc"), false);
    assert.equal(h.terminals.size, 0);
  }
  assert.deepEqual(agentArguments({ agent: "opencode", model: "opencode-go/deepseek-v4.1-flash" }, ["opencode", "--agent", "mini", "-mold/model"], "task"),
    ["opencode", "--agent", "mini", "--model", "opencode-go/deepseek-v4.1-flash", "--prompt", "task"]);
});

test("attached configured model flags still require model capability when a role uses CLI defaults", async () => {
  const h = harness();
  const profiles = defaultProfiles().map((p) => ({ ...p, model: "", enabled: p.id === "implement" }));
  const run = h.create({ profiles });
  h.controls.configured.opencode = ["opencode", "-mopencode-go/deepseek-v4.1-flash"];
  h.controls.rootHelp = "  --prompt <text>\n";
  h.controls.miniHelp = "  --prompt <text>\n";
  await assert.rejects(h.runtime.launch(run.id), /옵션을 확인하지 못/);
  assert.equal(h.terminals.size, 0);
});

test("explicit OpenCode run mode preserves positional messages but does not accept failed help probes", async () => {
  const h = harness(), run = openCodeRun(h);
  h.controls.configured.opencode = ["opencode", "run"];
  await h.runtime.launch(run.id);
  const argv = h.terminals.get("t1").argv;
  assert.equal(argv[argv.indexOf("opencode") + 1], "run");
  assert.equal(argv.includes("--prompt"), false);
  assert.ok(argv.at(-1).includes("AI Hub 팀 작업"));
  const other = harness();
  const profiles = defaultProfiles().map((p) => ({ ...p, model: "", enabled: p.id === "implement" }));
  const next = other.create({ profiles });
  other.controls.configured.opencode = ["opencode", "run"];
  other.controls.exec = () => ({ code: 1, stdout: "", stderr: "help failed" });
  await assert.rejects(other.runtime.launch(next.id), /옵션을 확인하지 못/);
  assert.equal(other.terminals.size, 0);
});

test("OpenCode model discovery retains configured server selection", async () => {
  const h = harness();
  h.controls.configured.opencode = ["opencode", "--server", "http://localhost:4096", "--model", "old/model"];
  await h.runtime.listModels({ folder: "/work/project" });
  const query = h.effects.find((e) => e[0] === "exec" && e[1] === "opencode");
  assert.deepEqual(query[2], ["models", "--server", "http://localhost:4096"]);
});

test("Windows OpenCode discovery uses a bounded one-shot PowerShell probe and preserves the model", async () => {
  const h = harness(); h.host.window = () => ({ platform: "windows" });
  const run = openCodeRun(h);
  await h.runtime.launch(run.id);
  const probes = h.effects.filter((e) => e[0] === "exec" && e[1] === "pwsh.exe" && e[2].at(-1).includes("'opencode'"));
  assert.ok(probes.length >= 2);
  for (const probe of probes) {
    assert.equal(probe[2].includes("-NoExit"), false);
    assert.equal(probe[2].includes("-ExecutionPolicy"), false);
    assert.ok(probe[3].timeout <= 30000);
  }
  const script = h.terminals.get("t1").argv.at(-1);
  assert.match(script, /'--model' 'opencode-go\/deepseek-v4\.1-flash'/);
  assert.match(script, /'--prompt' 'AI Hub/);
});

test("real Windows PowerShell shims preserve model/effort argv, exit codes, and scoped environment", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "aihub-shim-"));
  try {
    writeFileSync(join(directory, "capture.cjs"), 'if (process.argv.includes("--fail")) process.exit(7); console.log(JSON.stringify(process.argv.slice(2)));\n');
    const shim = join(directory, "opencode.cmd");
    writeFileSync(shim, '@echo off\r\n"' + process.execPath + '" "%~dp0capture.cjs" %*\r\n');
    const captureEnvironment = join(directory, "capture-env.cjs");
    writeFileSync(captureEnvironment, 'console.log(JSON.stringify({args: process.argv.slice(2), effort: process.env.CLAUDE_CODE_EFFORT_LEVEL}));\n');
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      const expected = ["models", "literal $() & text", "--model", goModel + "#high", "-c", "model_reasoning_effort=ultra"];
      const args = capturedArguments([shim, ...expected], shell);
      const output = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 15000 });
      assert.equal(output.status, 0, output.stderr || String(output.error));
      assert.deepEqual(JSON.parse(output.stdout.trim()), expected);
      const fail = capturedArguments([shim, "--fail"], shell);
      const stopped = spawnSync(fail[0], fail.slice(1), { encoding: "utf8", timeout: 15000 });
      assert.equal(stopped.status, 7, stopped.stderr || String(stopped.error));
      const launcher = launcherArguments("windows", [process.execPath, captureEnvironment, "--effort", "xhigh"], undefined, shell, { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" });
      const script = launcher.at(-1) + "; [Console]::WriteLine('RESTORED:' + $env:CLAUDE_CODE_EFFORT_LEVEL)";
      const launched = spawnSync(shell, ["-NoLogo", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15000, env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: "low" } });
      assert.equal(launched.status, 0, launched.stderr || String(launched.error));
      const lines = launched.stdout.trim().split(/\r?\n/);
      assert.deepEqual(JSON.parse(lines[0]), { args: ["--effort", "xhigh"], effort: "xhigh" });
      assert.equal(lines[1], "RESTORED:low");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real Windows launch and query restore literal cwd after startup cd and stop on missing directories", { skip: process.platform !== "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "aihub-cwd-"));
  try {
    const project = join(directory, "한글 [literal] & O'Brien");
    const startupFolder = join(directory, "profile-folder");
    mkdirSync(project); mkdirSync(startupFolder);
    // Windows may expose the same directory as RUNNER~1 or runneradmin.
    // Distinct files read relative to the child's cwd prove directory identity
    // without depending on either spelling or weakening the drift control.
    writeFileSync(join(project, ".aihub-cwd-fixture"), "selected-project");
    writeFileSync(join(startupFolder, ".aihub-cwd-fixture"), "profile-startup");
    writeFileSync(join(directory, "capture-cwd.cjs"), [
      "const fs = require('node:fs'); fs.writeFileSync(process.env.AI_HUB_TEST_CALLED, 'called');",
      "if (process.argv.includes('--fail')) process.exit(7);",
      // ASCII output keeps PS5's console encoding separate from Unicode cwd/argv.
      "console.log(Buffer.from(JSON.stringify({cwd:process.cwd(),directory:fs.readFileSync('.aihub-cwd-fixture','utf8'),args:process.argv.slice(2),profile:process.env.AI_HUB_TEST_PROFILE,effort:process.env.CLAUDE_CODE_EFFORT_LEVEL}),'utf8').toString('base64'));",
    ].join("\n") + "\n");
    const shim = join(directory, "opencode.cmd");
    writeFileSync(shim, '@echo off\r\n"' + process.execPath + '" "%~dp0capture-cwd.cjs" %*\r\n');
    const quote = (word) => "'" + word.replace(/'/g, "''") + "'";
    // Simulate a profile's startup cd without editing any actual profile.
    const startup = "Microsoft.PowerShell.Management\\Set-Location -LiteralPath " + quote(startupFolder)
      + " -ErrorAction Stop; $env:AI_HUB_TEST_PROFILE = 'profile-kept'; ";
    const expected = ["models", "literal $() & text", "--model", goModel + "#high", "-c", "model_reasoning_effort=ultra"];
    for (const shell of ["powershell.exe", "pwsh.exe"]) for (const mode of ["query", "launch"]) {
      const marker = join(directory, shell + "-" + mode + ".called");
      const invoke = (cwd, extra = []) => {
        rmSync(marker, { force: true });
        const argv = [shim, ...expected, ...extra];
        const args = mode === "query"
          ? capturedArguments(argv, shell, cwd)
          : launcherArguments("windows", argv, undefined, shell, { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" }, cwd);
        assert.equal(args.includes("-NoProfile"), false);
        assert.equal(args.includes("-ExecutionPolicy"), false);
        const suffix = mode === "launch" ? "; [Console]::WriteLine('RESTORED:' + $env:CLAUDE_CODE_EFFORT_LEVEL); exit 0" : "";
        // The production command body is unchanged; only close the successful
        // interactive shell in this bounded test instead of leaving it open.
        const flags = args.slice(1, -1).map((flag) => flag === "-NoExit" ? "-NonInteractive" : flag);
        return spawnSync(args[0], [...flags, startup + args.at(-1) + suffix], {
          cwd: project, encoding: "utf8", timeout: 15000,
          env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: "low", AI_HUB_TEST_CALLED: marker },
        });
      };
      const drifted = invoke(undefined);
      assert.equal(drifted.status, 0, shell + " " + mode + " control: " + (drifted.stderr || String(drifted.error)));
      const old = JSON.parse(Buffer.from(drifted.stdout.trim().split(/\r?\n/)[0], "base64").toString("utf8"));
      assert.equal(old.directory, "profile-startup",
        "omitted-cwd control must reproduce the profile's directory drift: " + old.cwd);
      const launched = invoke(project);
      assert.equal(launched.status, 0, shell + " " + mode + ": " + (launched.stderr || String(launched.error)));
      assert.equal(existsSync(marker), true);
      const lines = launched.stdout.trim().split(/\r?\n/);
      const observed = JSON.parse(Buffer.from(lines[0], "base64").toString("utf8"));
      assert.equal(observed.directory, "selected-project", shell + " " + mode + ": " + observed.cwd);
      assert.deepEqual(observed.args, expected);
      assert.equal(observed.profile, "profile-kept", "the startup environment survives");
      assert.equal(observed.effort, mode === "launch" ? "xhigh" : "low");
      if (mode === "launch") assert.equal(lines[1], "RESTORED:low");
      const failed = invoke(project, ["--fail"]);
      assert.equal(failed.status, 7, shell + " " + mode + ": " + (failed.stderr || String(failed.error)));
      assert.equal(existsSync(marker), true, "the CLI's own nonzero exit is preserved");
      const missing = invoke(join(project, "missing"));
      assert.equal(missing.status, 1, shell + " " + mode + ": " + (missing.stderr || String(missing.error)));
      assert.equal(existsSync(marker), false, "a failed cwd change must not start the CLI in the profile's folder");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
