// AI Hub modification (2026-11-24): model choices and verified effort capabilities.
// Presets are documented choices, not proof of installation, account access, or
// the model ultimately used by a provider. Custom model IDs remain supported.
export const OPTION_SOURCES = Object.freeze({
  claude: "https://code.claude.com/docs/en/model-config",
  claudeModels: "https://platform.claude.com/docs/en/models/overview",
  codex: "https://learn.chatgpt.com/docs/models",
  codexEffort: "https://learn.chatgpt.com/docs/config-file/config-reference",
  opencode: "https://opencode.ai/docs/models/",
});

const PRESETS = {
  claude: [
    ["claude-fable-5-2", "Claude Fable 5.2"],
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
    ["claude-haiku-5-5", "Claude Haiku 5.5"],
    ["fable", "Fable · CLI 별칭"],
    ["opus", "Opus · CLI 별칭"],
    ["sonnet", "Sonnet · CLI 별칭"],
    ["haiku", "Haiku · CLI 별칭"],
  ],
  codex: [
    ["gpt-6.2-sol", "GPT-6.2 Sol"],
    ["gpt-6.2-astra", "GPT-6.2 Astra"],
    ["gpt-6.1-terra", "GPT-6.1 Terra"],
    ["gpt-6-luna", "GPT-6 Luna"],
  ],
};
const CLAUDE_FULL = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_LEGACY = ["low", "medium", "high", "max"];
// Exact documented IDs only. Aliases can resolve differently across providers
// and environment overrides, so do not guess a capability for them.
const CLAUDE_EFFORTS = {
  "claude-fable-5-2": CLAUDE_FULL,
  "claude-opus-5-5": CLAUDE_FULL,
  "claude-opus-5": CLAUDE_FULL,
  "claude-opus-4-8": CLAUDE_FULL,
  "claude-opus-4-7": CLAUDE_FULL,
  "claude-sonnet-5-5": CLAUDE_FULL,
  "claude-sonnet-5": CLAUDE_FULL,
  "claude-haiku-5-5": CLAUDE_FULL,
  "claude-opus-4-6": CLAUDE_LEGACY,
  "claude-sonnet-4-6": CLAUDE_LEGACY,
};
const LABELS = {
  "": "도구 기본값", none: "없음 (none)", minimal: "최소 (minimal)",
  low: "낮음 (low)", medium: "보통 (medium)", high: "높음 (high)",
  xhigh: "매우 높음 (xhigh)", max: "최대 (max)", ultra: "울트라 (ultra)",
};
const TOOLS = new Set(["claude", "codex", "opencode"]);
const safeEffort = (value) => typeof value === "string" && value.length <= 32 && /^[a-z][a-z0-9_-]*$/.test(value);
const choice = (id, label) => ({ id, label, name: label });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function modelOptions(agent) {
  return [choice("", "도구 기본 모델"), ...(own(PRESETS, agent) ? PRESETS[agent] : []).map(([id, label]) => ({
    ...choice(id, label), source: OPTION_SOURCES[agent],
  }))];
}

function supportedEfforts(agent, model, capability) {
  if (!TOOLS.has(agent) || typeof model !== "string" || !model) return null;
  // A present, empty list is authoritative: the selected model has no advertised
  // levels. Malformed or mismatched metadata must not enable guessed options.
  if (capability != null) {
    if (typeof capability !== "object" || Array.isArray(capability)
      || (capability.id != null && capability.id !== model)) return null;
    if (own(capability, "efforts")) {
      const values = capability.efforts;
      if (!Array.isArray(values) || values.length > 32 || values.some((value) => !safeEffort(value))) return null;
      if (agent === "claude" && values.some((value) => !CLAUDE_FULL.includes(value))) return null;
      return [...new Set(values)];
    }
  }
  if (agent === "claude") return own(CLAUDE_EFFORTS, model) ? CLAUDE_EFFORTS[model] : null;
  // Codex advertises model/client-specific levels in its model catalog. OpenCode
  // variants are likewise model-specific; a name like "high" is not universal.
  return null;
}

export function effortOptions(agent, model = "", capability = null) {
  return [choice("", LABELS[""]), ...(supportedEfforts(agent, model, capability) ?? [])
    .map((id) => choice(id, own(LABELS, id) ? LABELS[id] : id))];
}

// Report a problem without rewriting the person's chosen model or effort.
// Persisted stage data is validated structurally by model.js. This capability
// check belongs at selection/launch time so newer custom catalogs remain usable.
export function effortProblem(agent, model, effort, capability = null) {
  if (effort === undefined || effort === "") return null;
  if (!safeEffort(effort)) return "추론 강도는 공백 없이 32자 이내의 안전한 식별자여야 합니다.";
  if (!TOOLS.has(agent)) return "이 도구의 추론 강도 지정은 지원하지 않습니다. 도구 기본값을 선택하세요.";
  if (!model) return "추론 강도를 지정하려면 모델을 먼저 선택하세요.";
  const supported = supportedEfforts(agent, model, capability);
  if (supported == null) return "이 모델의 추론 강도 지원 정보를 확인하지 못했습니다. 모델 목록을 확인하거나 도구 기본값을 선택하세요."
    + (agent === "claude" ? " Claude 별칭은 정확한 모델 ID로 선택하세요." : "");
  if (!supported.includes(effort)) return `이 모델은 선택한 추론 강도 '${effort}'를 지원하지 않습니다. 지원 목록에서 다시 선택하세요.`;
  return null;
}
