import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

/** The note shown under a failed reply: the API error, and how to fix it when the fix is on the user's side. */
export function apiErrorNote(code: SDKAssistantMessageError): string {
  switch (code) {
    case "authentication_failed":
      return "Claude Code is logged out (its login expired or was revoked). In a terminal, run: claude auth login. Then send your message again.";
    default:
      return `API error: ${code}`;
  }
}
