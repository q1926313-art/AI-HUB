// Real-terminal selection and viewer lifecycle checks; no provider calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createRun, defaultProfiles } from "../defaults/mods/team/model.js";
import { WORKSPACE_KEY, bindingsFor, choicesFor, createWorkspace, dismissWorkspace, changeWorkspace, preferences, selectStage, workspaceLayout } from "../defaults/mods/team/workspace.js";

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
function fixture() {
  return createRun({ title: "Visible team", goal: "Show the real current work", folder: "/work/project", profiles: defaultProfiles() }, { id: "visible-team", now: 10000 });
}
function launched(current, id, address, attempt = 1) {
  const stage = current.stages.find((item) => item.id === id);
  Object.assign(stage, { status: "running", startedAt: 10001, attempt, terminal: address });
  return { address, state: "live", status: "working", labels: { "aihub.run": current.id, "aihub.stage": id, "aihub.attempt": String(attempt) } };
}
function harness() {
  const data = new Map(), windows = [], closed = [];
  let live = [];
  const host = {
    shared: (key) => clone(data.get(key)),
    setShared: (key, value) => data.set(key, clone(value)),
    terminals: () => live,
    closeOverlay: (id) => closed.push(id),
    openOverlay(spec) {
      if (windows.length) {
        const previous = windows.at(-1).layout.children[0].content.props;
        // Native replacement disposes the previous toolbar.
        dismissWorkspace(host, previous.owner, previous.generation);
      }
      windows.push(spec);
      return "overlay-" + windows.length;
    },
    run: () => { throw new Error("A viewer must not launch or interrupt anything."); },
  };
  return { host, data, windows, closed, setLive: (value) => { live = value; } };
}

test("workspace gives Claude 65 percent and uses three real team terminal addresses", () => {
  const current = fixture();
  const live = [launched(current, "plan", "t-plan"), launched(current, "implement", "t-code"), launched(current, "review", "t-review")];
  const layout = workspaceLayout(current, live, null, "test-owner", 1);
  const [left, right] = layout.children[1].children;
  assert.equal(left.size.weight, 65);
  assert.equal(right.size.weight, 35);
  assert.equal(left.children[1].content.terminal, "t-plan");
  assert.equal(right.children[0].children[1].content.terminal, "t-review");
  assert.equal(right.children[1].children[1].content.terminal, "t-code");
  assert.equal(layout.resizable, false);
  assert.equal(right.children[0].size.weight, right.children[1].size.weight);
});

test("future verification does not mask current Claude work; a started verification follows it", () => {
  const current = fixture();
  launched(current, "plan", "t-plan");
  assert.equal(selectStage(current, "agent:claude").id, "plan");
  launched(current, "verify", "t-verify");
  assert.equal(selectStage(current, "agent:claude").id, "verify");
  assert.equal(selectStage(current, "stage:plan").id, "plan");
});

test("retry never reuses an old attempt or another run's terminal", () => {
  const current = fixture();
  const old = launched(current, "plan", "t-old");
  Object.assign(current.stages[0], { terminal: null, attempt: 2, status: "launching" });
  const wrongRun = { ...old, address: "t-other", labels: { ...old.labels, "aihub.run": "other", "aihub.attempt": "2" } };
  assert.equal(bindingsFor(current, [old, wrongRun])[0].terminal, null);
  const real = { ...old, address: "t-new", labels: { ...old.labels, "aihub.attempt": "2" } };
  assert.equal(bindingsFor(current, [old, real])[0].terminal, "t-new");
});

test("ambiguous ownership and mismatching recorded address remain placeholders", () => {
  const current = fixture();
  const terminal = launched(current, "plan", "t-one");
  assert.equal(bindingsFor(current, [terminal, { ...terminal, address: "t-two" }])[0].terminal, null);
  assert.equal(bindingsFor(current, [{ ...terminal, address: "t-two" }])[0].terminal, null);
});

test("the same PTY is not attached twice when slots choose the same role", () => {
  const current = fixture(), terminal = launched(current, "plan", "t-plan");
  const result = bindingsFor(current, [terminal], { choices: { left: "stage:plan", top: "stage:plan" } });
  assert.equal(result[0].terminal, "t-plan");
  assert.equal(result[1].terminal, null);
  assert.equal(result[1].duplicate, true);
});

test("custom tools and role names populate the assignment choices", () => {
  const current = fixture();
  current.stages = [{ ...current.stages[0], agent: "custom-tool", roleName: "Custom role" }];
  assert.equal(preferences(current).choices.left, "agent:custom-tool");
  assert.ok(choicesFor(current).some((item) => item.name === "Custom role · custom-tool"));
  assert.equal(preferences(current, { ratio: 500, choices: { left: "stage:missing" } }).ratio, 65);
});

test("unstarted roles have placeholders, never fabricated output or new launches", () => {
  const current = fixture();
  const layout = workspaceLayout(current, [], null, "test-owner", 1);
  assert.equal(layout.children[1].children[0].children[1].content.mod, "team");
  assert.equal(layout.children[1].children[0].children[1].content.props.view, "workspace");
  assert.equal(layout.children[1].children[0].children[1].content.props.role, "placeholder");
});

test("sync leaves streams and focus intact until the actual binding changes", () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  workspace.open(current);
  workspace.sync(current);
  assert.equal(h.windows.length, 1);
  h.setLive([launched(current, "plan", "t-plan")]);
  workspace.sync(current);
  assert.equal(h.windows.length, 2);
  assert.equal(h.data.get(WORKSPACE_KEY).open, true, "old close does not cancel replacement");
  current.stages[0].status = "ready";
  workspace.sync(current);
  assert.equal(h.windows.length, 2, "status changes redraw chrome without reattaching PTY");
});

test("user close or terminal-end close is respected until an explicit reopen", () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  workspace.open(current);
  const state = h.data.get(WORKSPACE_KEY);
  dismissWorkspace(h.host, state.owner, state.generation);
  h.setLive([launched(current, "plan", "t-plan")]);
  workspace.sync(current);
  assert.equal(h.windows.length, 1);
  workspace.open(current);
  assert.equal(h.windows.length, 2);
});

test("saved open state cannot reopen a workspace after its owner has gone", () => {
  const h = harness(), current = fixture();
  createWorkspace(h.host).open(current);
  const replacement = createWorkspace(h.host);
  replacement.sync(current);
  assert.equal(h.windows.length, 1);
  replacement.open(current);
  assert.equal(h.windows.length, 2);
});

test("only the current viewer can change placement and close its intent", () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  workspace.open(current);
  const state = h.data.get(WORKSPACE_KEY);
  assert.equal(changeWorkspace(h.host, "wrong", state.generation, { ratio: 75 }), false);
  assert.equal(changeWorkspace(h.host, state.owner, state.generation, { ratio: 75 }), true);
  workspace.sync(current);
  assert.equal(h.windows.at(-1).layout.children[1].children[0].size.weight, 75);
  assert.equal(dismissWorkspace(h.host, state.owner, state.generation), false);
  workspace.close();
  assert.equal(h.data.get(WORKSPACE_KEY).open, false);
  assert.equal(h.closed.at(-1), "overlay-2");
});

test("delayed launch respects a user close; a later explicit start can auto-open again", () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const firstRequest = workspace.autoOpenToken();
  workspace.autoOpen(current, firstRequest);
  const delayedRequest = workspace.autoOpenToken();
  const state = h.data.get(WORKSPACE_KEY);
  dismissWorkspace(h.host, state.owner, state.generation);
  h.setLive([launched(current, "plan", "t-plan")]);
  workspace.autoOpen(current, delayedRequest);
  assert.equal(h.windows.length, 1, "the completed launch cannot undo a close");
  const nextRequest = workspace.autoOpenToken();
  workspace.autoOpen(current, nextRequest);
  assert.equal(h.windows.length, 2, "a new user start may open the viewer");
});
