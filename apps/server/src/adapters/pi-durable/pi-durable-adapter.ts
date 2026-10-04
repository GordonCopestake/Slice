import type { Models } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type Registry,
  type SubmissionId,
  type Submission,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ApplicationStateStore } from "../../state/application-state.js";

export type PiDurableAdapterOptions = {
  readonly durableDatabasePath: string;
  readonly state: ApplicationStateStore;
  readonly models: Models;
  readonly registry?: Registry;
};

export class PiDurableAdapter {
  readonly harness: Harness;
  readonly #state: ApplicationStateStore;

  private constructor(harness: Harness, state: ApplicationStateStore) {
    this.harness = harness;
    this.#state = state;
  }

  static async open(options: PiDurableAdapterOptions): Promise<PiDurableAdapter> {
    const registry = options.registry ?? createRegistry();
    const storage = await openNodeSqliteStorage(options.durableDatabasePath, { busyTimeoutMs: 5000 });
    const harness = await Harness.open(storage, { models: options.models, registry }, BACKGROUND_CONTEXT);
    harness.resume();
    return new PiDurableAdapter(harness, options.state);
  }

  async createThread(agent: AgentChange): Promise<ConversationId> {
    const conversation = await this.harness.createConversation(
      { ownership: { kind: "ownerless" }, agent },
      BACKGROUND_CONTEXT,
    );
    return conversation.id;
  }

  async conversation(threadId: ConversationId): Promise<Conversation | undefined> {
    return this.harness.conversation(threadId, BACKGROUND_CONTEXT);
  }

  async submit(threadId: ConversationId, requestId: string, content: string): Promise<Submission> {
    if (content.trim().length === 0) throw new TypeError("A request cannot be empty");
    if (content.length > 100_000) throw new RangeError("A request cannot exceed 100,000 characters");

    const previousSubmissionId = this.#state.reserveSubmission(String(threadId), requestId, { content });
    if (previousSubmissionId !== undefined) {
      const existing = await this.harness.submission(previousSubmissionId as SubmissionId, BACKGROUND_CONTEXT);
      if (existing !== undefined) return existing;
      throw new Error("The request index points to a missing durable submission");
    }

    const conversation = await this.harness.conversation(threadId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("Unknown thread");
    const submission = await conversation.submit(
      { type: "input", content, requestId },
      BACKGROUND_CONTEXT,
    );
    this.#state.recordSubmission(String(threadId), requestId, submission.id);
    return submission;
  }

  async cancel(threadId: ConversationId): Promise<void> {
    const conversation = await this.harness.conversation(threadId, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error("Unknown thread");
    // `background` crosses background boundaries: an ordinary abort only reaches non-background tasks and leaves
    // conversation-owned background work running after this returns.
    await conversation.abort(BACKGROUND_CONTEXT, { background: true });
  }

  close(): Promise<void> {
    return this.harness.close(BACKGROUND_CONTEXT);
  }
}
