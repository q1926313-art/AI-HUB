// Real-terminal selection and viewer lifecycle checks; no provider calls.
import test from "node:test";
import assert from "node:assert/strict";
import { createRun, defaultProfiles } from "../defaults/mods/team/model.js";
import { WORKSPACE_KEY, bindingsFor, choicesFor, createWorkspace, dismissWorkspace, changeWorkspace, preferences, selectStage, workspaceLayout } from "../defaults/mods/team/workspace.js";

const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const placement = { spaceId: "spteam", tabId: "tbmanager", paneId: "pmanager" };
const context = { spaceId: placement.spaceId, managerTabId: placement.tabId, workspaceTabId: "tbwork" };
const walk = (node) => node ? [node, ...(node.children ?? []).flatMap(walk)] : [];
const addresses = (root) => walk(root).map((node) => node.content?.terminal).filter(Boolean);
const views = (root, hidden = false) => [
  ...(root?.content?.terminal ? [{ terminal: root.content.terminal, hidden: hidden || root.hidden === true }] : []),
  ...(root?.children ?? []).flatMap((node) => views(node, hidden || root.hidden === true)),
];
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  return createRun({ title: "Visible team", goal: "Show the real current work", folder: "/work/project", ...placement, profiles: defaultProfiles() }, { id: "visible-team", now: 10000 });
}
function launched(current, id, address, attempt = 1) {
  const stage = current.stages.find((item) => item.id === id);
  Object.assign(stage, { status: "running", startedAt: 10001, attempt, terminal: address });
  return { address, state: "live", status: "working", labels: { "aihub.run": current.id, "aihub.stage": id, "aihub.attempt": String(attempt) } };
}
function harness() {
  const data = new Map(), calls = [], roots = new Map();
  const controls = { beforeCommand: null };
  let live = [], sequence = 0;
  const spaces = [
    { id: "spteam", mod: "team", machine: null, active: true, tabs: [{ id: "tbmanager", managed: true, manager: true, active: true }] },
    { id: "spother", mod: null, machine: null, active: false, tabs: [{ id: "tbother", managed: false, manager: false, active: true }] },
  ];
  roots.set("tbmanager", { id: "tbmanager", type: "row", children: [{ id: "pmanager", type: "block", content: {
    mod: "team", props: { embedded: true, space: "spteam", tab: "tbmanager", pane: "pmanager" },
  } }] });
  roots.set("tbother", { id: "tbother", type: "row", children: [{ id: "pother", type: "block", content: { terminal: "t-unrelated" } }] });
  const closeRemovedToolbar = (previous, next) => {
    for (const node of walk(previous).filter((item) => item.content?.props?.role === "toolbar")) {
      const retained = walk(next).find((item) => item.id === node.id && JSON.stringify(item.content) === JSON.stringify(node.content));
      if (!retained) dismissWorkspace(host, node.content.props.owner, node.content.props.generation);
    }
  };
  const stripTerminal = (node, terminal) => {
    if (node.content?.terminal === terminal) return null;
    return node.children ? { ...node, children: node.children.map((child) => stripTerminal(child, terminal)).filter(Boolean) } : node;
  };
  const host = {
    placement: clone(placement),
    shared: (key) => clone(data.get(key)),
    setShared: (key, value) => data.set(key, clone(value)),
    spaces: () => clone(spaces), terminals: () => clone(live),
    async command(name, input = {}) {
      const args = clone(input); calls.push({ name, args });
      if (controls.beforeCommand) await controls.beforeCommand(name, args);
      if (name === "tab.new") {
        assert.equal(args.mod, "team"); assert.equal(args.focus, false, "creation must not steal focus");
        const space = spaces.find((entry) => entry.id === args.space);
        assert.ok(space && !space.machine && space.mod === "team");
        const tab = "tbwork" + (++sequence), pane = "pwork" + sequence;
        space.tabs.push({ id: tab, managed: true, manager: false, active: false });
        roots.set(tab, { id: tab, type: "row", children: [{ id: pane, type: "block", content: { mod: args.mod, props: args.props } }] });
        return { space: space.id, tab, pane };
      }
      if (name === "tab.layout") {
        const space = spaces.find((entry) => entry.tabs.some((tab) => tab.id === args.id));
        if (!space || !roots.has(args.id)) throw new Error("no tab " + args.id);
        const old = roots.get(args.id);
        if (args.layout) {
          if (JSON.stringify(args.expected) !== JSON.stringify(old)) throw new Error("tab.layout changed; read it again before saving");
          const next = args.layout, included = addresses(next), previous = addresses(old);
          assert.equal(next.id, args.id); assert.ok(["row", "column"].includes(next.type));
          assert.equal(new Set(included).size, included.length, "a PTY may be attached only once");
          assert.equal(new Set(walk(next).map((node) => node.id)).size, walk(next).length);
          for (const terminal of previous) assert.ok(included.includes(terminal), "tab.layout must retain each existing terminal, including hidden ones");
          for (const proof of args.adopt ?? []) {
            assert.ok(included.includes(proof.terminal));
            assert.deepEqual(Object.keys(proof.labels).sort(), ["aihub.attempt", "aihub.run", "aihub.stage"]);
            const terminal = live.find((entry) => entry.address === proof.terminal);
            assert.ok(terminal && terminal.state !== "finished" && !proof.terminal.includes("/"));
            for (const [key, value] of Object.entries(proof.labels)) assert.equal(terminal.labels[key], value, "native adoption verifies all three ownership labels");
          }
          for (const terminal of included.filter((address) => !previous.includes(address))) {
            assert.ok(args.adopt?.some((proof) => proof.terminal === terminal), "new addresses require an exact adoption proof");
            for (const [id, root] of roots) if (id !== args.id) roots.set(id, stripTerminal(root, terminal));
          }
          roots.set(args.id, clone(next)); closeRemovedToolbar(old, next);
        }
        return { space: space.id, tab: args.id, layout: clone(roots.get(args.id)) };
      }
      if (name === "tab.select") {
        assert.ok(roots.has(args.id));
        for (const space of spaces) {
          space.active = space.tabs.some((tab) => tab.id === args.id);
          if (space.active) for (const tab of space.tabs) tab.active = tab.id === args.id;
        }
        return null;
      }
      if (name === "pane.focus") { assert.ok([...roots.values()].some((root) => views(root).some((view) => view.terminal === args.terminal && !view.hidden))); return null; }
      throw new Error("A viewer must not launch, interrupt, close or rewrite another application surface: " + name);
    },
  };
  const closeTab = (id) => {
    const old = roots.get(id); roots.delete(id);
    for (const space of spaces) space.tabs = space.tabs.filter((tab) => tab.id !== id);
    closeRemovedToolbar(old, null);
  };
  const endTerminal = (address) => {
    live = live.map((terminal) => terminal.address === address ? { ...terminal, state: "finished" } : terminal);
    for (const [id, root] of roots) roots.set(id, stripTerminal(root, address));
  };
  return { host, data, calls, roots, spaces, controls, closeTab, endTerminal,
    setLive: (value) => { live = value; },
    count: (name) => calls.filter((call) => call.name === name).length,
    writes: () => calls.filter((call) => call.name === "tab.layout" && call.args.layout),
    switchSpace: (id) => { for (const space of spaces) space.active = space.id === id; },
  };
}

test("workspace gives Claude 65 percent and uses three real team terminal addresses", () => {
  const current = fixture();
  const live = [launched(current, "plan", "t-plan"), launched(current, "implement", "t-code"), launched(current, "review", "t-review")];
  const layout = workspaceLayout(current, live, null, "test-owner", 1, context);
  const [left, right] = layout.children[1].children;
  assert.equal(left.size.weight, 65);
  assert.equal(right.size.weight, 35);
  assert.equal(left.children[1].content.terminal, "t-plan");
  assert.equal(right.children[0].children[1].content.terminal, "t-review");
  assert.equal(right.children[1].children[1].content.terminal, "t-code");
  assert.equal(layout.resizable, false);
  assert.equal(layout.id, context.workspaceTabId);
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
  const layout = workspaceLayout(current, [], null, "test-owner", 1, context);
  assert.equal(layout.children[1].children[0].children[1].content.mod, "team");
  assert.equal(layout.children[1].children[0].children[1].content.props.view, "workspace");
  assert.equal(layout.children[1].children[0].children[1].content.props.role, "placeholder");
});

test("finished terminals stay out of bindings and old attempts remain hidden in the existing tab", () => {
  const current = fixture(), plan = launched(current, "plan", "t-plan");
  const first = workspaceLayout(current, [plan], null, "test-owner", 1, context);
  const before = clone(first);
  const verify = launched(current, "verify", "t-verify");
  const next = workspaceLayout(current, [plan, verify], null, "test-owner", 1, context, first);
  assert.deepEqual(first, before);
  assert.deepEqual(views(next).filter((view) => !view.hidden).map((view) => view.terminal), ["t-verify"]);
  assert.deepEqual(views(next).filter((view) => view.hidden).map((view) => view.terminal), ["t-plan"]);
  const retry = launched(current, "verify", "t-retry", 2);
  const retried = workspaceLayout(current, [plan, verify, retry], null, "test-owner", 1, context, next);
  assert.deepEqual(views(retried).filter((view) => view.hidden).map((view) => view.terminal), ["t-plan", "t-verify"]);
  assert.equal(new Set(addresses(retried)).size, 3);
  assert.equal(bindingsFor(current, [{ ...retry, state: "finished" }])[0].terminal, null);
});

test("assignment picker stays inline and legacy width preferences survive normalization", () => {
  const current = fixture(), prefs = preferences(current, { ratio: 75, picker: "top" });
  const layout = workspaceLayout(current, [], prefs, "test-owner", 1, context);
  const picker = walk(layout).filter((node) => node.content?.props?.role === "picker");
  assert.equal(picker.length, 1); assert.equal(picker[0].content.mod, "team");
  assert.equal(picker[0].content.props.binding.slot, "top");
  assert.equal(layout.children.find((node) => node.type === "row").children[0].size.weight, 75);
  assert.equal(preferences(current, { picker: "bad" }).picker, null);
});

test("sync reuses the native tab, adopts exact team terminals and leaves the manager and unrelated work intact", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const manager = clone(h.roots.get("tbmanager"));
  const tab = await workspace.open(current);
  await workspace.sync(current);
  assert.equal(h.count("tab.new"), 1); assert.equal(h.writes().length, 1);
  const terminal = launched(current, "plan", "t-plan"); h.setLive([terminal]);
  h.roots.get("tbother").children.push({ id: "pold-team", type: "block", content: { terminal: terminal.address } });
  const selects = h.count("tab.select");
  await workspace.sync(current);
  assert.equal(h.count("tab.select"), selects); assert.equal(h.writes().length, 2);
  assert.deepEqual(h.writes().at(-1).args.adopt, [{ terminal: terminal.address, labels: terminal.labels }]);
  assert.deepEqual(addresses(h.roots.get("tbother")), ["t-unrelated"]);
  assert.deepEqual(h.roots.get("tbmanager"), manager);
  assert.equal(h.data.get(WORKSPACE_KEY).tabId, tab); assert.equal(h.data.get(WORKSPACE_KEY).open, true);
  current.stages[0].status = "ready"; await workspace.sync(current);
  assert.equal(h.writes().length, 2, "status-only updates do not reattach the PTY");
});

test("repeated and concurrent explicit opens share one work tab and an explicit stage focuses its PTY", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  h.setLive([launched(current, "plan", "t-plan")]);
  const [first, second] = await Promise.all([workspace.open(current), workspace.open(current)]);
  assert.equal(first, second); assert.equal(h.count("tab.new"), 1);
  await workspace.open(current, { stageId: "plan" });
  assert.equal(h.calls.at(-1).name, "pane.focus"); assert.equal(h.calls.at(-1).args.terminal, "t-plan");
  const focuses = h.count("pane.focus");
  await workspace.open(current, { stageId: "plan" });
  assert.equal(h.count("pane.focus"), focuses + 1, "reopening an already-selected stage should still focus its terminal");
});

test("saved open intent alone cannot create a tab, and a first explicit open retains old preferences", async () => {
  const h = harness(), current = fixture();
  h.data.set(WORKSPACE_KEY, { owner: "old-overlay", generation: 3, runId: current.id, open: true, ratio: 75 });
  const workspace = createWorkspace(h.host); await workspace.sync(current);
  assert.equal(h.count("tab.new"), 0); assert.equal(h.count("tab.select"), 0);
  await workspace.open(current);
  assert.equal(h.data.get(WORKSPACE_KEY).ratio, 75);
  assert.equal(h.data.get(WORKSPACE_KEY).spaceId, placement.spaceId);
  assert.equal(h.data.get(WORKSPACE_KEY).managerTabId, placement.tabId);
});

test("closing the native work tab blocks passive or delayed reopening until a fresh explicit request", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current), delayed = workspace.autoOpenToken();
  h.closeTab(tab); h.setLive([launched(current, "plan", "t-plan")]);
  await workspace.sync(current); await workspace.autoOpen(current, delayed);
  assert.equal(h.count("tab.new"), 1); assert.equal(h.data.get(WORKSPACE_KEY).open, false);
  await workspace.autoOpen(current, workspace.autoOpenToken());
  assert.equal(h.count("tab.new"), 2, "a later user Start request may reopen the work tab");
  const calls = h.calls.length;
  h.closeTab(placement.tabId); await workspace.sync(current); await workspace.autoOpen(current, workspace.autoOpenToken());
  assert.equal(h.calls.length, calls, "a missing manager stops passive updates and creation");
});

test("switching to another Space preserves focus during synchronization and a delayed launch", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  await workspace.open(current); const token = workspace.autoOpenToken();
  h.switchSpace("spother"); const selects = h.count("tab.select");
  h.setLive([launched(current, "plan", "t-plan")]);
  await workspace.sync(current); await workspace.autoOpen(current, token);
  assert.equal(h.count("tab.select"), selects); assert.equal(h.count("pane.focus"), 0);
  assert.equal(h.spaces.find((space) => space.active).id, "spother");
});

test("a delayed request from a new controller respects a close recorded by the previous owner", async () => {
  const h = harness(), current = fixture(), previous = createWorkspace(h.host);
  const tab = await previous.open(current), replacement = createWorkspace(h.host);
  const token = replacement.autoOpenToken();
  h.closeTab(tab);
  await replacement.autoOpen(current, token);
  assert.equal(h.count("tab.new"), 1, "an owner change does not erase the user's intervening close");
  await replacement.autoOpen(current, replacement.autoOpenToken());
  assert.equal(h.count("tab.new"), 2, "a new user request after that close may create a work tab");
});

test("a remote or unrelated Space cannot masquerade as the team's dedicated manager", async () => {
  for (const change of [
    (space) => { space.machine = "remote"; },
    (space) => { space.mod = "notes"; },
    (space) => { space.tabs[0].managed = false; },
    (space) => { space.tabs[0].manager = false; },
  ]) {
    const h = harness(), current = fixture(); change(h.spaces[0]);
    const workspace = createWorkspace(h.host);
    await workspace.sync(current);
    await assert.rejects(workspace.open(current), /관리 탭/);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(addresses(h.roots.get("tbother")), ["t-unrelated"]);
  }
});

test("a reopened manager restores its existing owned tab without creating, focusing, or arming work", async () => {
  const h = harness(), current = fixture(), previous = createWorkspace(h.host);
  h.setLive([launched(current, "plan", "t-plan")]);
  const tab = await previous.open(current), old = clone(h.data.get(WORKSPACE_KEY));
  previous.close(); h.switchSpace("spother");
  const selects = h.count("tab.select"), restored = createWorkspace(h.host);
  await restored.sync(current);
  assert.equal(h.count("tab.new"), 1); assert.equal(h.count("tab.select"), selects);
  assert.equal(h.data.get(WORKSPACE_KEY).tabId, tab); assert.equal(h.data.get(WORKSPACE_KEY).open, true);
  assert.notEqual(h.data.get(WORKSPACE_KEY).owner, old.owner);
  assert.equal(dismissWorkspace(h.host, old.owner, old.generation), false);
  assert.equal(changeWorkspace(h.host, old.owner, old.generation, { ratio: 55 }), false);
  const owner = h.data.get(WORKSPACE_KEY);
  assert.equal(changeWorkspace(h.host, owner.owner, owner.generation, { ratio: 75 }), true);
  await restored.sync(current);
  assert.equal(h.roots.get(tab).children.find((node) => node.type === "row").children[0].size.weight, 75);
  assert.equal(h.data.get(WORKSPACE_KEY).open, true, "disposing old toolbar generations cannot close the new owner");
});

test("a terminal end restores a placeholder in the same work tab while other terminals remain attached", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  h.setLive([launched(current, "plan", "t-plan"), launched(current, "review", "t-review")]);
  const tab = await workspace.open(current); h.endTerminal("t-plan");
  await workspace.sync(current);
  assert.equal(h.count("tab.new"), 1); assert.equal(h.data.get(WORKSPACE_KEY).tabId, tab);
  assert.deepEqual(addresses(h.roots.get(tab)), ["t-review"]);
  assert.ok(walk(h.roots.get(tab)).some((node) => node.content?.props?.role === "placeholder" && node.content.props.binding.slot === "left"));
  assert.ok(h.roots.has(placement.tabId));
});

test("one sync recovers a native CAS conflict using fresh bindings and preserves the existing terminal", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current), terminal = launched(current, "plan", "t-plan");
  current.stages[0].terminal = null;
  const snapshot = clone(current), writes = h.writes().length, selects = h.count("tab.select");
  let collided = false;
  h.controls.beforeCommand = async (name, args) => {
    if (name === "tab.layout" && args.layout && !collided) {
      collided = true;
      h.roots.get(tab).children.push({ id: "concurrent-archive", type: "column", hidden: true, children: [{ id: "pracing", type: "block", content: { terminal: "t-racing" } }] });
      h.setLive([terminal]);
    }
  };
  assert.equal(await workspace.sync(current), tab);
  assert.equal(h.writes().length, writes + 2, "the same request rereads and rebuilds after its first conflict");
  assert.deepEqual(views(h.roots.get(tab)).filter((view) => view.hidden).map((view) => view.terminal), ["t-racing"]);
  assert.deepEqual(views(h.roots.get(tab)).filter((view) => !view.hidden).map((view) => view.terminal), ["t-plan"]);
  assert.deepEqual(h.writes().at(-1).args.adopt, [{ terminal: "t-plan", labels: terminal.labels }]);
  assert.deepEqual(current, snapshot, "finding the current attempt does not alter its identity or create another attempt");
  assert.equal(h.count("tab.new"), 1); assert.equal(h.count("tab.select"), selects);
});

test("repeated native conflicts stop after three writes without replacing the tab or losing archived work", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current); h.setLive([launched(current, "plan", "t-plan")]);
  const writes = h.writes().length, selects = h.count("tab.select");
  let conflicts = 0;
  h.controls.beforeCommand = async (name, args) => {
    if (name === "tab.layout" && args.layout) {
      const index = ++conflicts;
      h.roots.get(tab).children.push({ id: "racing-archive-" + index, type: "column", hidden: true,
        children: [{ id: "pracing-" + index, type: "block", content: { terminal: "t-racing-" + index } }] });
    }
  };
  await assert.rejects(workspace.sync(current), /tab.layout changed/);
  assert.equal(conflicts, 3); assert.equal(h.writes().length, writes + 3);
  assert.deepEqual(addresses(h.roots.get(tab)), ["t-racing-1", "t-racing-2", "t-racing-3"]);
  assert.equal(h.count("tab.new"), 1); assert.equal(h.count("tab.select"), selects);
  assert.equal(h.data.get(WORKSPACE_KEY).tabId, tab);
});

test("a close observed after a conflict stops retries without recreating or focusing the work tab", async () => {
  for (const target of ["work", "manager"]) {
    const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
    const tab = await workspace.open(current), token = workspace.autoOpenToken();
    h.setLive([launched(current, "plan", "t-plan")]);
    const writes = h.writes().length, selects = h.count("tab.select");
    h.controls.beforeCommand = async (name, args) => {
      if (name === "tab.layout" && args.layout) {
        h.closeTab(target === "work" ? tab : placement.tabId);
        throw new Error("herdr.command: tab.layout changed; read it again before saving");
      }
    };
    assert.equal(await workspace.open(current, { stageId: "plan" }), null);
    assert.equal(h.writes().length, writes + 1, "a closed target is not retried");
    await workspace.sync(current); await workspace.autoOpen(current, token);
    assert.equal(h.count("tab.new"), 1); assert.equal(h.count("tab.select"), selects);
    assert.equal(h.count("pane.focus"), 0);
  }
});

test("a new workspace owner observed after a conflict is not overwritten by the old request", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current); h.setLive([launched(current, "plan", "t-plan")]);
  const writes = h.writes().length, selects = h.count("tab.select");
  let replacement;
  h.controls.beforeCommand = async (name, args) => {
    if (name === "tab.layout" && args.layout) {
      const prior = h.data.get(WORKSPACE_KEY);
      replacement = { ...prior, owner: "replacement-owner", generation: prior.generation + 1, revision: prior.revision + 1 };
      h.data.set(WORKSPACE_KEY, clone(replacement));
      throw new Error("tab.layout changed; read it again before saving");
    }
  };
  assert.equal(await workspace.open(current), null);
  assert.deepEqual(h.data.get(WORKSPACE_KEY), replacement);
  assert.equal(h.writes().length, writes + 1); assert.equal(h.count("tab.new"), 1);
  assert.equal(h.count("tab.select"), selects); assert.ok(h.roots.has(tab));
});

test("a foreign panel discovered by the fresh CAS read is preserved instead of overwritten", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current); h.setLive([launched(current, "plan", "t-plan")]);
  const writes = h.writes().length;
  let afterEdit;
  h.controls.beforeCommand = async (name, args) => {
    if (name === "tab.layout" && args.layout && !afterEdit) {
      h.roots.get(tab).children.push({ id: "racing-notes", type: "block", content: { mod: "personal-notes", props: { file: "/notes.md" } } });
      afterEdit = clone(h.roots.get(tab));
    }
  };
  await assert.rejects(workspace.sync(current), /다른 패널/);
  assert.deepEqual(h.roots.get(tab), afterEdit);
  assert.equal(h.writes().length, writes + 1, "revalidation stops before a second write");
  assert.equal(h.count("tab.new"), 1);
});

test("an explicit stage open focuses the current PTY only after its CAS retry succeeds", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current); h.setLive([launched(current, "plan", "t-plan")]);
  const writes = h.writes().length, selects = h.count("tab.select");
  let collided = false;
  h.controls.beforeCommand = async (name, args) => {
    if (name === "tab.layout" && args.layout && !collided) {
      collided = true;
      h.roots.get(tab).children.push({ id: "racing-archive", type: "column", hidden: true,
        children: [{ id: "pracing", type: "block", content: { terminal: "t-racing" } }] });
      throw new Error("herdr.command: tab.layout changed; read it again before saving");
    }
  };
  assert.equal(await workspace.open(current, { stageId: "plan" }), tab);
  assert.equal(h.writes().length, writes + 2); assert.equal(h.count("tab.new"), 1);
  assert.equal(h.count("tab.select"), selects + 1); assert.equal(h.count("pane.focus"), 1);
  assert.deepEqual(h.calls.at(-1), { name: "pane.focus", args: { terminal: "t-plan" } });
});

test("ordinary layout validation failures are reported without a CAS retry", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current); h.setLive([launched(current, "plan", "t-plan")]);
  const before = clone(h.roots.get(tab)), writes = h.writes().length, layoutCalls = h.count("tab.layout");
  h.controls.beforeCommand = async (name, args) => {
    if (name === "tab.layout" && args.layout) throw new Error("terminal no longer matches its adoption labels");
  };
  await assert.rejects(workspace.sync(current), /no longer matches its adoption labels/);
  assert.equal(h.writes().length, writes + 1); assert.equal(h.count("tab.layout"), layoutCalls + 2);
  assert.deepEqual(h.roots.get(tab), before); assert.equal(h.count("tab.new"), 1);
});

test("a foreign panel added to the work tab is preserved and blocks automatic replacement", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  const tab = await workspace.open(current), owner = h.data.get(WORKSPACE_KEY);
  h.roots.get(tab).children.push({ id: "personal-notes", type: "block", content: { mod: "personal-notes", props: { file: "/notes.md" } } });
  const before = clone(h.roots.get(tab));
  changeWorkspace(h.host, owner.owner, owner.generation, { ratio: 75 });
  await assert.rejects(workspace.sync(current), /다른 패널/);
  assert.deepEqual(h.roots.get(tab), before); assert.equal(h.count("tab.new"), 1);
});

test("closing the controller during a deferred native create cannot publish or focus a late workspace", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host), entered = deferred(), release = deferred();
  h.controls.beforeCommand = async (name) => { if (name === "tab.new") { entered.resolve(); await release.promise; } };
  const opening = workspace.open(current);
  try { await entered.promise; workspace.close(); } finally { release.resolve(); }
  assert.equal(await opening, null);
  await workspace.sync(current);
  assert.equal(h.count("tab.new"), 1, "only the already-sent create may finish");
  assert.equal(h.writes().length, 0); assert.equal(h.count("tab.select"), 0);
  assert.notEqual(h.data.get(WORKSPACE_KEY)?.open, true);
});

test("closing the controller during a deferred layout update leaves its intent closed", async () => {
  const h = harness(), current = fixture(), workspace = createWorkspace(h.host);
  await workspace.open(current); h.setLive([launched(current, "plan", "t-plan")]);
  const entered = deferred(), release = deferred(), selects = h.count("tab.select");
  h.controls.beforeCommand = async (name, args) => { if (name === "tab.layout" && args.layout) { entered.resolve(); await release.promise; } };
  const opening = workspace.open(current);
  try { await entered.promise; workspace.close(); } finally { release.resolve(); }
  assert.equal(await opening, null); assert.equal(h.data.get(WORKSPACE_KEY).open, false);
  await workspace.sync(current);
  assert.equal(h.count("tab.new"), 1); assert.equal(h.count("tab.select"), selects);
});
