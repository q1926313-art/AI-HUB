// AI Hub: ordinary, persistent mod spaces and checked tab composition.
// This changes only the app's model. It never launches or kills a terminal.
use super::*;
use serde::{Deserialize, Serialize};

const OWNER: &str = "herdr.mod-owner";
const MANAGER: &str = "herdr.mod-manager";
const ARCHIVE: &str = "herdr.mod-archive";
const REGISTRY: &str = "herdr.managed-spaces.v1";

#[derive(Clone, Deserialize)]
pub(super) struct SpaceSpec {
    #[serde(default)]
    name: String,
    #[serde(default)]
    tab: String,
    #[serde(default)]
    props: Value,
}

#[derive(Default, Deserialize, Serialize)]
struct Registry {
    // A known id which is no longer present must never be recreated by a late
    // terminal launch. Reopening a mod creates fresh ids, not a reused name.
    #[serde(default)]
    spaces: BTreeMap<String, BTreeSet<String>>,
}

pub(super) fn owner(space: &model::Space) -> Option<&str> {
    space.rest.get(OWNER).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub(super) fn managed(tab: &Tab) -> bool {
    tab.rest.get(OWNER).and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

pub(super) fn manager(tab: &Tab) -> bool {
    tab.rest.get(MANAGER).and_then(Value::as_str).is_some()
}

pub(super) fn specification(dir: &std::path::Path) -> Result<Option<SpaceSpec>, String> {
    let source = match std::fs::read_to_string(dir.join("mod.json")) {
        Ok(source) => source,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("cannot read mod.json: {e}")),
    };
    let value: Value = serde_json::from_str(&source).map_err(|e| format!("mod.json: {e}"))?;
    let Some(space) = value.get("space") else { return Ok(None) };
    let spec: SpaceSpec = serde_json::from_value(space.clone()).map_err(|e| format!("mod.json space: {e}"))?;
    if !spec.props.is_null() && !spec.props.is_object() {
        return Err("mod.json space.props must be an object".into());
    }
    Ok(Some(spec))
}

fn registry() -> Registry {
    mods::shared(REGISTRY).and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default()
}

fn remember(model: &Model) {
    let mut known = registry();
    for space in model.spaces.iter().filter(|space| space.machine.is_none() && owner(space).is_some()) {
        let tabs = known.spaces.entry(space.id.clone()).or_default();
        tabs.extend(space.tabs.iter().filter(|tab| managed(tab)).map(|tab| tab.id.clone()));
    }
    mods::set_shared(REGISTRY.into(), json!(known));
}

fn allows_adoption(model: &Model, known: &Registry, space: &str, tab: Option<&str>) -> bool {
    if let Some(target) = model.space(space).filter(|s| owner(s).is_some()) {
        // Managed spaces never grow unsolicited tabs. Explicit tab.new creates
        // a tab; an incoming process may only join a tab which still exists.
        return tab.is_some_and(|id| target.tab(id).is_some());
    }
    if let Some(tabs) = known.spaces.get(space) {
        if model.space(space).is_none() { return false; }
        if tab.is_some_and(|id| tabs.contains(id) && model.tab(id).is_none()) { return false; }
    }
    true
}

fn props_for(spec: &SpaceSpec, space: &str, tab: &str, pane: &str) -> Value {
    let mut props = if spec.props.is_object() { spec.props.clone() } else { json!({}) };
    props["embedded"] = json!(true);
    props["space"] = json!(space);
    props["tab"] = json!(tab);
    props["pane"] = json!(pane);
    props
}

fn make_manager(model: &mut Model, name: &str, spec: &SpaceSpec, space: &str) -> Tab {
    let tab = model.fresh_id("tb");
    let pane = model.fresh_id("p");
    let props = props_for(spec, space, &tab, &pane);
    let mut node = Node::block(pane.clone(), Content::Mod { name: name.into(), props });
    // Closing the tab/Space is explicit; a pane-close must not strand its
    // controller while already launched terminals remain in the archive.
    node.closable = Some(false);
    node.movable = Some(false);
    let mut tab = Tab::with_pane(&tab, spec.tab.trim(), node);
    tab.rest.insert(OWNER.into(), json!(name));
    tab.rest.insert(MANAGER.into(), json!(pane));
    tab
}

fn ensure_space(model: &mut Model, name: &str, spec: &SpaceSpec, folder: &str) -> Result<Value, String> {
    let owned: Vec<String> = model.spaces.iter().filter(|space| space.machine.is_none() && owner(space) == Some(name)).map(|s| s.id.clone()).collect();
    if owned.len() > 1 { return Err(format!("more than one Space is owned by mod {name:?}; no Space was selected")); }
    let space = if let Some(space) = owned.first() {
        space.clone()
    } else {
        let space = model.fresh_id("sp");
        let tab = make_manager(model, name, spec, &space);
        model.add_space(&space, if spec.name.trim().is_empty() { name } else { spec.name.trim() }, folder, tab);
        model.space_mut(&space).unwrap().rest.insert(OWNER.into(), json!(name));
        space
    };
    let managers: Vec<(String, String)> = model.space(&space).unwrap().tabs.iter().filter_map(|tab| {
        let pane = tab.rest.get(MANAGER)?.as_str()?;
        match tab.root.find(pane)?.content()? {
            Content::Mod { name: current, props } if current == name && props["embedded"] == true
                && props["space"] == space && props["tab"] == tab.id && props["pane"] == pane => Some((tab.id.clone(), pane.into())),
            _ => None,
        }
    }).collect();
    if managers.len() > 1 { return Err(format!("more than one management tab belongs to mod {name:?}")); }
    let (tab, pane) = if let Some(existing) = managers.first() {
        existing.clone()
    } else {
        let tab = make_manager(model, name, spec, &space);
        let answer = (tab.id.clone(), tab.rest[MANAGER].as_str().unwrap().to_owned());
        model.add_tab(&space, tab);
        answer
    };
    model.select_tab(&tab);
    model.focus_pane(&pane);
    Ok(json!({ "space":space, "tab":tab, "pane":pane }))
}

pub(super) fn mark_tab(model: &mut Model, space: &str, tab: &str, name: &str) {
    if model.space(space).is_some_and(|s| s.machine.is_none() && owner(s) == Some(name)) {
        if let Some(tab) = model.tab_mut(tab) { tab.rest.insert(OWNER.into(), json!(name)); }
        remember(model);
    }
}

/// A newly observed terminal joins a hidden archive until its mod chooses a
/// visible slot. This must not resize the authored composition or take focus.
fn archive_terminal(model: &mut Model, address: &str, space: &str, id: Option<&str>) -> bool {
    let Some(id) = id.filter(|id| model.space(space).and_then(|s| s.tab(id)).is_some_and(managed)) else { return false };
    if model.pane_of(address).is_some() { return true; }
    let machine = model.space(space).and_then(|space| space.machine.clone());
    let pane = model.fresh_id_on("p", machine.as_deref());
    let new_archive = model.fresh_id_on("s", machine.as_deref());
    let tab = model.tab_mut(id).unwrap();
    let archive = tab.rest.get(ARCHIVE).and_then(Value::as_str).map(str::to_owned);
    if let Some(node) = archive.as_deref().and_then(|id| tab.root.find_mut(id)).filter(|n| n.hidden && n.axis().is_some()) {
        node.children_mut().unwrap().push(model::pane(&pane, address));
        return true;
    }
    let mut archive = Node::container(new_archive.clone(), Axis::Row, vec![model::pane(&pane, address)]);
    archive.hidden = true;
    if let Some(children) = tab.root.children_mut() {
        children.push(archive);
    } else {
        tab.root = Node::container(tab.id.clone(), Axis::Row, vec![tab.root.clone(), archive]);
    }
    tab.rest.insert(ARCHIVE.into(), json!(new_archive));
    true
}

fn checked_shape(value: &Value, depth: usize, count: &mut usize) -> Result<(), String> {
    *count += 1;
    if depth > 24 || *count > 512 { return Err("tab.layout exceeds the depth or node limit".into()); }
    let object = value.as_object().ok_or("each tab layout node must be an object")?;
    const FIELDS: &[&str] = &["id", "type", "content", "children", "size", "min", "max", "hidden", "title", "background", "border", "radius", "shadow", "padding", "focus", "gap", "divider", "movable", "closable", "resizable", "theme", "colors", "font", "font_size", "font_weight", "font_weight_bold", "terminal_line_height", "terminal_cell_width", "terminal_scroll_speed", "ui_font", "terminal_padding", "terminal_opacity"];
    if let Some(key) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) { return Err(format!("tab.layout node field {key:?} is not supported")); }
    match value["type"].as_str() {
        Some("row" | "column") => {
            if object.contains_key("content") { return Err("a tab container cannot have content".into()); }
            let children = value["children"].as_array().ok_or("tab containers need a children array")?;
            for child in children { checked_shape(child, depth + 1, count)?; }
        }
        Some("block") => {
            if object.contains_key("children") { return Err("a tab block cannot have children".into()); }
            let content = value["content"].as_object().ok_or("tab blocks need content")?;
            let terminal = content.get("terminal").is_some_and(Value::is_string) && content.len() == 1;
            let module = content.get("mod").is_some_and(Value::is_string) && content.keys().all(|key| matches!(key.as_str(), "mod" | "props"));
            if !terminal && !module { return Err("tab.layout blocks support only one terminal or mod content".into()); }
        }
        _ => return Err("tab.layout supports row, column and terminal/mod blocks only".into()),
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(|ch| ch.is_control() || ch == '#')
        && !id.starts_with("overlay:") && !id.starts_with("float:")
}

fn layout_reply(model: &Model, id: &str) -> Result<Value, String> {
    let space = model.space_of(id).ok_or_else(|| format!("no tab {id:?}"))?;
    let tab = space.tab(id).ok_or_else(|| format!("no tab {id:?}"))?;
    Ok(json!({ "space":space.id, "tab":tab.id, "layout":tab.root }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Adopt {
    terminal: String,
    labels: BTreeMap<String, String>,
}

fn replace_layout(model: &mut Model, live: &HashMap<String, Value>, chrome: &Node, id: &str, value: Value, expected: &Value, adopt: Option<&Value>, mod_exists: impl Fn(&str) -> bool) -> Result<Value, String> {
    let tab = model.tab(id).ok_or_else(|| format!("no tab {id:?}"))?;
    if &json!(tab.root) != expected { return Err("tab.layout changed; read it again before saving".into()); }
    let target_space = model.space_of(id).unwrap();
    if target_space.machine.is_some() { return Err("tab.layout currently supports local Spaces only".into()); }
    if value.to_string().len() > crate::mod_files::LIMIT as usize { return Err("tab.layout exceeds 1 MiB".into()); }
    checked_shape(&value, 0, &mut 0)?;
    let root: Node = serde_json::from_value(value).map_err(|e| format!("tab.layout: {e}"))?;
    if root.id != id || !matches!(root.kind, Kind::Row { .. } | Kind::Column { .. }) || root.hidden {
        return Err("tab.layout root must be a visible row/column whose id is the tab id".into());
    }
    let mut ids = HashSet::new();
    let mut terminals = HashSet::new();
    for node in root.walk() {
        if !valid_id(&node.id) || !ids.insert(node.id.clone()) { return Err(format!("invalid or repeated tab node id {:?}", node.id)); }
        if node.size.is_some_and(|size| match size { Span::Px { px } => !px.is_finite() || px < 0., Span::Weight { weight } => !weight.is_finite() || weight <= 0. }) {
            return Err(format!("invalid size for node {:?}", node.id));
        }
        if node.min.is_some_and(|v| !v.is_finite() || v < 0.) || node.max.is_some_and(|v| !v.is_finite() || v < 0.)
            || node.min.zip(node.max).is_some_and(|(min, max)| min > max) { return Err(format!("invalid bounds for node {:?}", node.id)); }
        match node.content() {
            Some(Content::Terminal { terminal }) => {
                if !valid_id(terminal) || terminal.contains('/') || !terminals.insert(terminal.clone()) { return Err("invalid, remote or repeated terminal in tab.layout".into()); }
            }
            Some(Content::Mod { name, .. }) if !mod_exists(name) => return Err(format!("no mod {name:?} in mods/")),
            _ => {}
        }
    }
    if !root.visible_blocks().iter().any(|node| node.is_pane()) { return Err("tab.layout needs a visible terminal or mod pane".into()); }
    let previous: HashSet<String> = model::addresses(&tab.root).into_iter().collect();
    if let Some(terminal) = previous.difference(&terminals).next() {
        return Err(format!("tab.layout cannot drop terminal {terminal:?}; retain it in the layout or a hidden archive"));
    }
    if let Some(pane) = tab.rest.get(MANAGER).and_then(Value::as_str) {
        if tab.root.find(pane).and_then(Node::content) != root.find(pane).and_then(Node::content) {
            return Err("tab.layout must preserve its management pane and props".into());
        }
    }
    let proofs: Vec<Adopt> = match adopt {
        None => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|e| format!("tab.layout adopt: {e}"))?,
    };
    let mut proof_ids = HashSet::new();
    for proof in &proofs {
        if !terminals.contains(&proof.terminal) || !proof_ids.insert(proof.terminal.clone()) || proof.labels.is_empty()
            || proof.labels.iter().any(|(key, value)| key.is_empty() || value.is_empty()) { return Err("adopt needs unique included terminals and nonempty matching labels".into()); }
        let record = live.get(&proof.terminal).ok_or_else(|| format!("no live terminal {:?} to adopt", proof.terminal))?;
        if record["state"] == "finished" || proof.labels.iter().any(|(key, value)| record.get("labels").and_then(|labels| labels.get(key)).and_then(Value::as_str) != Some(value.as_str())) {
            return Err(format!("terminal {:?} no longer matches its adoption labels", proof.terminal));
        }
    }
    let mut moving = Vec::new();
    for terminal in terminals.difference(&previous) {
        if !proof_ids.contains(terminal) { return Err(format!("terminal {terminal:?} requires an explicit matching adopt entry")); }
        if let Some(pane) = model.pane_of(terminal) {
            if model.space_of(&pane).is_some_and(|space| space.machine.is_some()) { return Err("cannot move a pane from another machine".into()); }
            moving.push(pane);
        }
    }
    // No node may alias another tab's mod copy, pane header, or chrome slot.
    let moving_ids: HashSet<&str> = moving.iter().map(String::as_str).collect();
    for other in model.tabs().filter(|tab| tab.id != id) {
        for node in other.root.walk() {
            if ids.contains(&node.id) && !moving_ids.contains(node.id.as_str()) { return Err(format!("node id {:?} is already owned by another tab", node.id)); }
        }
    }
    if chrome.walk().iter().any(|node| ids.contains(&node.id) || node.floating.iter().any(|float| ids.contains(&float.id)))
        || model.spaces.iter().any(|space| ids.contains(&space.id)) { return Err("tab node ids collide with a Space or window layout".into()); }
    // Validate first, then edit a private projection. No failed call changes
    // selection, source tabs, destination roots, or terminal lifetime.
    let mut next = Model::default();
    next.spaces = model.spaces.clone();
    next.active = model.active.clone();
    next.recent = model.recent.clone();
    for pane in moving { next.remove_pane(&pane); }
    let target = next.tab_mut(id).ok_or("destination tab disappeared")?;
    target.root = root;
    let visible: HashSet<String> = target.root.visible_blocks().iter().filter(|node| node.is_pane()).map(|node| node.id.clone()).collect();
    target.before.retain(|pane| visible.contains(pane));
    target.zoomed = target.zoomed.take().filter(|pane| visible.contains(pane));
    if !target.focused.as_ref().is_some_and(|pane| visible.contains(pane)) {
        target.focused = target.root.visible_blocks().iter().find(|node| node.is_pane()).map(|node| node.id.clone());
    }
    model.spaces = next.spaces;
    model.active = next.active;
    model.recent = next.recent;
    layout_reply(model, id)
}

impl AppWindow {
    pub(super) fn open_mod_space(&mut self, name: &str, spec: &SpaceSpec) -> Result<Value, String> {
        self.require_document(None)?;
        let folder = self.model.focused_pane().and_then(|pane| self.model.address_of(&pane))
            .filter(|address| !address.contains('/')).and_then(|address| self.cwds.get(&address).cloned()).unwrap_or_else(home);
        let reply = ensure_space(&mut self.model, name, spec, &folder)?;
        self.focused_block = None;
        self.focused_pane = None;
        remember(&self.model);
        Ok(reply)
    }

    pub(super) fn allow_adoption(&self, space: &str, tab: Option<&str>) -> bool {
        allows_adoption(&self.model, &registry(), space, tab)
    }

    pub(super) fn archive_adopted(&mut self, address: &str, space: &str, tab: Option<&str>) -> bool {
        archive_terminal(&mut self.model, address, space, tab)
    }

    pub(super) fn remember_managed_spaces(&self) { remember(&self.model); }

    pub(super) fn tab_layout(&mut self, args: &Value) -> Result<Value, String> {
        let id = Self::arg(args, "id").ok_or("tab.layout needs an explicit tab id")?;
        let Some(layout) = args.get("layout") else {
            if args.get("expected").is_some() || args.get("adopt").is_some() { return Err("expected/adopt require a new tab layout".into()); }
            return layout_reply(&self.model, id);
        };
        let expected = args.get("expected").ok_or("tab.layout needs expected from its last read")?;
        let folders = &self.folders;
        replace_layout(&mut self.model, &self.live, &self.chrome, id, layout.clone(), expected, args.get("adopt"), |name| folders.get(name).is_some_and(|folder| folder.has_view))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Model {
        let mut model = Model::default();
        model.add_space("personal", "AI team", "/mine", Tab::new("source", "mine", "original", "t1"));
        let tab = Tab::with_pane("work", "work", Node::block("placeholder", Content::Mod { name: "board".into(), props: json!({}) }));
        model.add_space("owned", "team", "/work", tab);
        model
    }

    fn composition() -> Value {
        json!({"id":"work","type":"row","children":[
            {"id":"view","type":"block","content":{"terminal":"t1"}},
            {"id":"tools","type":"block","content":{"mod":"board","props":{}}}
        ]})
    }

    fn live() -> HashMap<String, Value> {
        HashMap::from([("t1".into(), json!({"address":"t1","state":"running","labels":{"run":"r1","stage":"plan","attempt":"1"}}))])
    }

    fn proof() -> Value { json!([{"terminal":"t1","labels":{"run":"r1","stage":"plan","attempt":"1"}}]) }
    fn chrome() -> Node { Node::container("chrome", Axis::Row, vec![]) }
    fn set(model: &mut Model, value: Value, expected: &Value, adopt: Option<&Value>) -> Result<Value, String> {
        replace_layout(model, &live(), &chrome(), "work", value, expected, adopt, |name| name == "board")
    }

    #[test]
    fn mod_space_uses_owner_not_name_and_reselects_identical_controller() {
        let mut model = setup();
        let spec = SpaceSpec { name: "AI team".into(), tab: "Manage".into(), props: json!({"custom":7,"space":"fake"}) };
        let made = ensure_space(&mut model, "board", &spec, "/work").unwrap();
        assert_ne!(made["space"], "personal");
        assert_eq!(model.spaces.len(), 3);
        let first = crate::mirror::Document::capture(&model, None);
        model.select_tab("source");
        assert_eq!(ensure_space(&mut model, "board", &spec, "/other").unwrap(), made);
        assert_eq!(crate::mirror::Document::capture(&model, None), first);
        let tab = model.tab(made["tab"].as_str().unwrap()).unwrap();
        assert!(tab.root.terminals().is_empty());
        let pane = tab.root.find(made["pane"].as_str().unwrap()).unwrap();
        assert!(!pane.closable());
        let Content::Mod { props, .. } = pane.content().unwrap() else { panic!() };
        assert_eq!(props["custom"], 7);
        assert_eq!(props["space"], made["space"]);
        assert_eq!(props["embedded"], true);
        let mut restored = Model::default();
        first.replace(&mut restored, None);
        assert_eq!(ensure_space(&mut restored, "board", &spec, "/ignored").unwrap(), made);
    }

    #[test]
    fn closed_manager_is_recreated_inside_the_same_owned_space() {
        let mut model = setup();
        let spec = SpaceSpec { name: "Team".into(), tab: "Manage".into(), props: Value::Null };
        let first = ensure_space(&mut model, "board", &spec, "/work").unwrap();
        let space = first["space"].as_str().unwrap();
        model.add_tab(space, Tab::with_pane("keep", "Work", Node::block("keep-pane", Content::Mod { name: "board".into(), props: Value::Null })));
        model.remove_tab(first["tab"].as_str().unwrap());
        let reopened = ensure_space(&mut model, "board", &spec, "/work").unwrap();
        assert_eq!(reopened["space"], first["space"]);
        assert_ne!(reopened["tab"], first["tab"]);
        assert!(model.tab("keep").is_some());
    }

    #[test]
    fn layout_adoption_is_explicit_atomic_and_keeps_other_user_panes() {
        let mut model = setup();
        model.split("original", Axis::Row, "unrelated", "t2");
        let expected = json!(model.tab("work").unwrap().root);
        let before = crate::mirror::Document::capture(&model, None);
        assert!(set(&mut model, composition(), &expected, None).is_err());
        assert!(set(&mut model, composition(), &expected, Some(&json!([{"terminal":"t1","labels":{"run":"other"}}]))).is_err());
        assert_eq!(crate::mirror::Document::capture(&model, None), before);
        let answer = set(&mut model, composition(), &expected, Some(&proof())).unwrap();
        assert_eq!(answer["tab"], "work");
        assert_eq!(model.pane_of("t1").as_deref(), Some("view"));
        assert_eq!(model.address_of("unrelated").as_deref(), Some("t2"));
        assert_eq!(model.tab_of("unrelated").unwrap().id, "source");
    }

    #[test]
    fn stale_layout_and_partial_invalid_adoption_leave_every_tab_untouched() {
        let mut model = setup();
        let before = crate::mirror::Document::capture(&model, None);
        assert!(set(&mut model, composition(), &json!({}), Some(&proof())).is_err());
        let expected = json!(model.tab("work").unwrap().root);
        let proofs = json!([{"terminal":"t1","labels":{"run":"r1"}},{"terminal":"missing","labels":{"run":"r1"}}]);
        assert!(set(&mut model, composition(), &expected, Some(&proofs)).is_err());
        assert_eq!(crate::mirror::Document::capture(&model, None), before);
    }

    #[test]
    fn retained_hidden_terminals_do_not_disappear_or_keep_hidden_focus() {
        let mut model = setup();
        let expected = json!(model.tab("work").unwrap().root);
        set(&mut model, composition(), &expected, Some(&proof())).unwrap();
        model.focus_pane("view");
        model.tab_mut("work").unwrap().zoomed = Some("view".into());
        let expected = json!(model.tab("work").unwrap().root);
        let dropped = json!({"id":"work","type":"row","children":[{"id":"tools","type":"block","content":{"mod":"board","props":{}}}]});
        assert!(set(&mut model, dropped, &expected, None).is_err());
        let mut archived = composition();
        archived["children"][0]["hidden"] = json!(true);
        set(&mut model, archived, &expected, None).unwrap();
        assert_eq!(model.pane_of("t1").as_deref(), Some("view"));
        assert_eq!(model.tab("work").unwrap().focused.as_deref(), Some("tools"));
        assert_eq!(model.tab("work").unwrap().zoomed, None);
    }

    #[test]
    fn unsupported_compositions_and_collisions_are_rejected_before_mutating() {
        let mut model = setup();
        let expected = json!(model.tab("work").unwrap().root);
        let before = crate::mirror::Document::capture(&model, None);
        let mut variants = Vec::new();
        let mut duplicate = composition(); duplicate["children"][1]["id"] = json!("view"); variants.push(duplicate);
        let mut duplicate_terminal = composition(); duplicate_terminal["children"][1]["content"] = json!({"terminal":"t1"}); variants.push(duplicate_terminal);
        let mut context = composition(); context["children"][0]["content"] = json!({"tab":"active"}); variants.push(context);
        let mut mixed = composition(); mixed["children"][0]["content"]["tab"] = json!("active"); variants.push(mixed);
        let mut stack = composition(); stack["type"] = json!("stack"); variants.push(stack);
        let mut float = composition(); float["floating"] = json!([]); variants.push(float);
        let mut collision = composition(); collision["children"][1]["id"] = json!("chrome"); variants.push(collision);
        let mut unknown = composition(); unknown["children"][1]["content"] = json!({"mod":"absent"}); variants.push(unknown);
        let mut remote = composition(); remote["children"][0]["content"] = json!({"terminal":"server/t1"}); variants.push(remote);
        let mut bounds = composition(); bounds["children"][0]["min"] = json!(20); bounds["children"][0]["max"] = json!(10); variants.push(bounds);
        let mut zero_weight = composition(); zero_weight["children"][0]["size"] = json!({"weight":0}); variants.push(zero_weight);
        let mut wrong_root = composition(); wrong_root["id"] = json!("another-tab"); variants.push(wrong_root);
        for value in variants { assert!(set(&mut model, value, &expected, Some(&proof())).is_err()); }
        assert_eq!(crate::mirror::Document::capture(&model, None), before);
    }

    #[test]
    fn managed_arrivals_stay_hidden_and_closed_ids_cannot_be_recreated() {
        let mut model = setup();
        model.space_mut("owned").unwrap().rest.insert(OWNER.into(), json!("board"));
        model.tab_mut("work").unwrap().rest.insert(OWNER.into(), json!("board"));
        let known = Registry { spaces: BTreeMap::from([("owned".into(), BTreeSet::from(["work".into()]))]) };
        let focused = model.tab("work").unwrap().focused.clone();
        assert!(allows_adoption(&model, &known, "owned", Some("work")));
        assert!(!allows_adoption(&model, &known, "owned", Some("unknown")));
        assert!(archive_terminal(&mut model, "late", "owned", Some("work")));
        assert_eq!(model.tab("work").unwrap().root.visible_blocks().len(), 1);
        assert!(model.pane_of("late").is_some());
        assert_eq!(model.tab("work").unwrap().focused, focused);
        model.remove_space("owned");
        assert!(!allows_adoption(&model, &known, "owned", Some("work")));
        assert!(allows_adoption(&model, &known, "new-user-space", Some("new-tab")));
        // A managed document viewed from another machine still uses qualified
        // node ids, even though tab.layout edits are restricted to local Spaces.
        model.add_space("server/owned", "remote", "/work", Tab::with_pane("server/work", "work", Node::block("server/tools", Content::Mod {name:"board".into(),props:Value::Null})));
        model.space_mut("server/owned").unwrap().machine = Some("server".into());
        model.tab_mut("server/work").unwrap().rest.insert(OWNER.into(), json!("board"));
        assert!(archive_terminal(&mut model, "server/t3", "server/owned", Some("server/work")));
        assert!(model.tab("server/work").unwrap().root.walk().iter().all(|node| node.id.starts_with("server/")));
    }

    #[test]
    fn manager_props_and_live_adoption_identity_are_not_replaceable() {
        let mut model = setup();
        let expected = json!(model.tab("work").unwrap().root);
        let mut ended = live();
        ended.get_mut("t1").unwrap()["state"] = json!("finished");
        assert!(replace_layout(&mut model, &ended, &chrome(), "work", composition(), &expected, Some(&proof()), |_| true).is_err());
        model.tab_mut("work").unwrap().rest.insert(MANAGER.into(), json!("placeholder"));
        let changed = json!({"id":"work","type":"row","children":[{"id":"placeholder","type":"block","content":{"mod":"board","props":{"changed":true}}}]});
        assert!(set(&mut model, changed, &expected, None).is_err());
        assert_eq!(json!(model.tab("work").unwrap().root), expected);
    }
}
