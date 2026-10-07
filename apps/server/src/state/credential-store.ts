import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

type StoredCredentials = Record<string, Credential>;

/**
 * Credentials live in one owner-only file inside the state directory. The file holds bearer tokens and refresh tokens,
 * so it is created and replaced with mode 0600 and never logged. Writes go to a temporary file and are renamed, so a
 * crash mid-write cannot leave a truncated credential file that would silently sign the owner out.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#path = join(directory, "credentials.json");
  }

  get path(): string {
    return this.#path;
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#readAll()[providerId];
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    // Metadata only; never resolve or return a secret.
    return Object.entries(this.#readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    change: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const all = this.#readAll();
      const updated = await change(all[providerId]);
      if (updated === undefined) return all[providerId];
      all[providerId] = updated;
      this.#writeAll(all);
      return updated;
    });
    // Keep the chain alive even when a change throws, so later writes still serialise.
    this.#chains.set(providerId, next.catch(() => undefined));
    return next;
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    // Not modify(async () => undefined): the store contract says a modify that returns undefined leaves the
    // entry unchanged, so removal must be its own serialised write.
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(() => {
      const all = this.#readAll();
      if (all[providerId] === undefined) return;
      delete all[providerId];
      this.#writeAll(all);
    });
    this.#chains.set(providerId, next.catch(() => undefined));
    await next;
    this.#chains.delete(providerId);
  }

  #readAll(): StoredCredentials {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const entries = Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, Credential] => typeof entry[1] === "object" && entry[1] !== null,
      );
      return Object.fromEntries(entries);
    } catch {
      // A missing or unreadable file means no stored credential, not a crash.
      return {};
    }
  }

  #writeAll(all: StoredCredentials): void {
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
    // renameSync keeps the temporary file's mode, but set it again in case an existing file was replaced.
    chmodSync(this.#path, 0o600);
  }

  /** Remove the stored credentials. Used by a sign-out path, never during normal operation. */
  destroy(): void {
    rmSync(this.#path, { force: true });
    rmSync(`${this.#path}.tmp`, { force: true });
  }
}