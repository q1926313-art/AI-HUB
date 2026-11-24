// AI Hub addition (2026-11-24): prepare a local report for the user's GitHub review.
export const ISSUE_URL = "https://github.com/q1926313-art/AI-HUB/issues/new";

export function issueReport(body) {
  const message = String(body?.message ?? "").trim();
  if (!message) throw new Error("Write a message first.");
  if (message.length > 4000) throw new Error("Keep the message to 4000 characters.");
  const app = body?.app ?? {};
  return [
    "## What happened",
    "",
    message,
    "",
    "## App details",
    "",
    `- AI Hub version: ${app.version ?? "unknown"}`,
    `- System: ${app.os ?? "unknown"} / ${app.arch ?? "unknown"}`,
    `- herdr-core version: ${body?.core?.version ?? "unknown"}`,
    `- Layout: ${body?.layout ?? "unknown"}`,
    "",
    "Add screenshots here if they help explain the problem.",
  ].join("\n");
}
