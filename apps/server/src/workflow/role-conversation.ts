import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, type ConversationId } from "@earendil-works/pi-durable";
import type { PiDurableAdapter } from "../adapters/pi-durable/pi-durable-adapter.js";
import type { ModelProfile } from "./coordinator.js";

/**
 * One durable turn for a role conversation: create the conversation, submit the input, wait for the
 * answer, and read the assistant text. Every role in Phase 2 goes through this single path so no
 * role can reach Pi Durable APIs the workflow has not vetted.
 */
export async function createRoleConversation(adapter: PiDurableAdapter, profile: ModelProfile, instructions: string): Promise<ConversationId> {
  return await adapter.createThread({ model: { provider: profile.provider, modelId: profile.modelId }, instructions });
}

export type RoleTurnResult = { ok: true; text: string } | { ok: false; status: string };

export async function runRoleTurn(adapter: PiDurableAdapter, threadId: ConversationId, requestId: string, content: string): Promise<RoleTurnResult> {
  const submission = await adapter.submit(threadId, requestId, content);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== "done" || settled.answer === undefined) return { ok: false, status: settled.status };
  const conversation = await adapter.conversation(threadId);
  if (conversation === undefined) return { ok: false, status: "conversation_missing" };
  const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
  const message = entry?.model?.[0];
  if (message === undefined) return { ok: true, text: "" };
  if (typeof message.content === "string") return { ok: true, text: message.content };
  return { ok: true, text: message.content.filter((block) => block.type === "text").map((block) => block.text).join("") };
}

/** Extract the single JSON object a role must return; anything else is a failed task, never a pass. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
