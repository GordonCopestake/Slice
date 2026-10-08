export type TelegramSendOutcome = { status: "sent" } | { status: "failed"; reason: string } | { status: "uncertain"; reason: string };

export type TelegramMessage = { updateId: number; messageId: number; chatId: string; text: string };

export type TelegramGateway = {
  sendMessage(chatId: string, text: string): Promise<TelegramSendOutcome>;
  getUpdates(offset: number): Promise<TelegramMessage[]>;
};

/**
 * Telegram over the Bot HTTP API with plain fetch. The token is only ever present in the request
 * URL of the live call: never in argv, logs, stored rows, or model context. A network failure
 * after the request left is 'uncertain' (the message may still arrive); an explicit refusal is
 * 'failed' and may be retried.
 */
export class TelegramClient implements TelegramGateway {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: { token: string; fetchImpl?: typeof fetch; baseUrl?: string }) {
    if (options.token.trim().length === 0) throw new TypeError("A Telegram bot token is required");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? "https://api.telegram.org";
  }

  async sendMessage(chatId: string, text: string): Promise<TelegramSendOutcome> {
    if (!/^-?\d{1,20}$/.test(chatId)) return { status: "failed", reason: "chat id is invalid" };
    try {
      const response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4_000), disable_web_page_preview: true }),
      });
      if (response.ok) return { status: "sent" };
      if (response.status >= 400 && response.status < 500) return { status: "failed", reason: `telegram refused: ${response.status}` };
      return { status: "failed", reason: `telegram upstream error: ${response.status}` };
    } catch {
      // The request may or may not have reached Telegram; a blind replay can duplicate.
      return { status: "uncertain", reason: "delivery outcome unknown" };
    }
  }

  /** Long-poll-free getUpdates used only for the account-linking flow. */
  async getUpdates(offset: number): Promise<TelegramMessage[]> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/getUpdates?offset=${offset + 1}&timeout=0`, { method: "GET" });
      if (!response.ok) return [];
      const json = await response.json() as { result?: { update_id?: number; message_id?: number; chat?: { id?: number }; text?: string }[] };
      const messages: TelegramMessage[] = [];
      for (const item of json.result ?? []) {
        if (typeof item.text !== "string" || typeof item.chat?.id !== "number" || typeof item.message_id !== "number" || typeof item.update_id !== "number") continue;
        messages.push({ updateId: item.update_id, messageId: item.message_id, chatId: String(item.chat.id), text: item.text });
      }
      return messages;
    } catch {
      return [];
    }
  }
}
