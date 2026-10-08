import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WorkflowStore } from "../records/workflow-store.js";

export type Session = {
  token: string;
  csrfToken: string;
};

const SESSION_COOKIE = "slice_session";
const SESSION_DAYS = 7;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Single-owner session auth. The password itself is environment-supplied and only its scrypt
 * derivation is stored. Session cookies are HttpOnly and SameSite=Strict; every mutating route
 * additionally requires the CSRF token issued at login, checked against the stored hash.
 * TLS termination is the reverse proxy's job; set SLICE_COOKIE_SECURE=1 behind TLS.
 */
export class OwnerAuth {
  readonly #store: WorkflowStore;
  readonly #secureCookie: boolean;

  constructor(store: WorkflowStore, environment: NodeJS.ProcessEnv) {
    this.#store = store;
    this.#secureCookie = environment.SLICE_COOKIE_SECURE === "1" || environment.SLICE_COOKIE_SECURE === "true";
    const password = environment.SLICE_OWNER_PASSWORD;
    if (password !== undefined) {
      // Re-deriving on each start lets the owner rotate the password through the environment.
      this.#store.storeOwnerPassword(password);
    }
  }

  get enabled(): boolean {
    return this.#store.hasOwnerPassword();
  }

  login(password: string): Session | null {
    if (!this.enabled || !this.#store.verifyOwnerPassword(password)) return null;
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    this.#store.createSession(sha256(token), sha256(csrfToken), Date.now() + SESSION_DAYS * 86_400_000);
    return { token, csrfToken };
  }

  sessionCookie(session: Session): string {
    const attributes = [`${SESSION_COOKIE}=${encodeURIComponent(session.token)}`, "HttpOnly", "SameSite=Strict", "Path=/"];
    if (this.#secureCookie) attributes.push("Secure");
    return attributes.join("; ");
  }

  clearSessionCookie(): string {
    const attributes = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
    if (this.#secureCookie) attributes.push("Secure");
    return attributes.join("; ");
  }

  readSession(request: { headers: Record<string, string | string[] | undefined> }): { session: Session; csrfHash: string } | null {
    const raw = request.headers.cookie;
    if (typeof raw !== "string") return null;
    for (const part of raw.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== SESSION_COOKIE) continue;
      const token = decodeURIComponent(rest.join("="));
      if (token.length === 0) return null;
      const stored = this.#store.getSession(sha256(token));
      if (stored === undefined) return null;
      return { session: { token, csrfToken: "" }, csrfHash: stored.csrfHash };
    }
    return null;
  }

  verifyCsrf(csrfHash: string, presented: string | undefined): boolean {
    if (presented === undefined || presented.length === 0) return false;
    const expected = Buffer.from(csrfHash, "hex");
    const actual = Buffer.from(sha256(presented), "hex");
    return timingSafeEqual(expected, actual);
  }

  /**
   * Resume a live session after a page reload. The plaintext CSRF token is never stored, so a new
   * one is issued and its hash replaces the old: only a client that already holds the HttpOnly
   * session cookie can obtain it, and any previously leaked token stops working at the same time.
   */
  resumeSession(request: { headers: Record<string, string | string[] | undefined> }): Session | null {
    const read = this.readSession(request);
    if (read === null) return null;
    const csrfToken = randomBytes(32).toString("base64url");
    if (!this.#store.rotateSessionCsrf(sha256(read.session.token), sha256(csrfToken))) return null;
    return { token: read.session.token, csrfToken };
  }

  endSession(token: string): void {
    this.#store.endSession(sha256(token));
  }
}
