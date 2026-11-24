// AI Hub team runtime contract checks. No model requests, accounts, or real core are used.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, reportFile, launcherArguments } from "../defaults/mods/team/runtime.js";
import { STATE_KEY, LIMITS, defaultProfiles } from "../defaults/mods/team/model.js";

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const okay = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
let harnessSequence = 0;

function harness() {
  const home = "/home/test/ai-hub-test-" + (++harnessSequence);
  const data = new Map(), files = new Map(), terminals = new Map(), effects = [];
  let clock = 10000, sequence = 0, idSequence = 0;
  const controls = { run: null, ls: null, get: null, interrupt: "stopped", installed: ["claude", "codex", "gemini"] };
  const host = {
    shared(key) { return clone(data.get(key)); },
    setShared(key, value) { data.set(key, clone(value)); },
    now: () => ++clock,
    makeId: () => "team-test-" + (++idSequence),
    window: () => ({ platform: "linux" }),
    appHome: () => home,
    async knownAgents() { return controls.installed.map((key) => ({ key, installed: true, run: key === "codex" ? ["codex", "--no-daemon"] : [key] })); },
    async readTextFile(file) { effects.push(["read", file]); return files.get(file) ?? null; },
    async writeTextFile(file, text, expected) {
      assert.equal(files.get(file) ?? null, expected, "writes use a current expected snapshot");
      effects.push(["write", file]); files.set(file, text);
    },
    async exec(command, args, options) {
      effects.push(["exec", command, args, options]);
      if (command === "git") return { code: 128, stdout: "", stderr: "not a repository" };
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
        return okay(terminal);
      }
      if (args[0] === "ls") {
        if (controls.ls) return controls.ls();
        const filters = args.flatMap((arg, i) => arg === "--label" ? [args[i + 1]] : []);
        return okay({ terminals: [...terminals.values()].filter((terminal) => filters.every((filter) => {
          const at = filter.indexOf("="); return terminal.labels[filter.slice(0, at)] === filter.slice(at + 1);
        })) });
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
  const codex = [...h.terminals.values()].find((t) => t.labels["aihub.stage"] === "implement");
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
  const profiles = defaultProfiles(); profiles[0].agent = "gemini";
  h.runtime.saveProfiles(profiles);
  assert.equal(h.current(run.id).stages[0].agent, "claude");
  assert.equal(h.create().stages[0].agent, "gemini");
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
  h.host.knownAgents = () => { entered(); return new Promise((resolve) => { release = () => resolve([{ key: "codex", installed: true, run: ["codex", "--no-daemon"] }]); }); };
  const pending = h.runtime.refresh(run.id, { autoAdvance: true });
  await barrier; h.runtime.pause(run.id); release(); await pending;
  assert.equal(h.terminals.size, 1);
  assert.equal(h.stage(run.id).id, "implement");
  assert.equal(h.stage(run.id).status, "stopped");
});
