import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script, runInNewContext } from "node:vm";
import { test } from "node:test";

/**
 * The web app is served to browsers as plain JavaScript; nothing compiles it. A stray TypeScript
 * annotation or any other syntax error would break the whole page at load time, so the shipped
 * file must parse as plain JS.
 */
test("the web app parses as plain browser JavaScript", () => {
  const source = readFileSync(join(process.cwd(), "apps/web/public/app.js"), "utf8");
  assert.doesNotThrow(() => new Script(source), "apps/web/public/app.js must be valid plain JavaScript");
  // Type annotations are the specific regression this guards against.
  assert.ok(!/:\s*(string|number|boolean|unknown)\s*[,)=]/u.test(source), "no TypeScript annotations may ship in the browser bundle");
});

/**
 * crypto.randomUUID and crypto.subtle exist only in a secure context (https, or http on localhost).
 * The owner can serve this UI over plain HTTP on a tailnet or LAN address, where they are undefined -
 * and a page that calls one at load time is then dead in the browser while every test still passes.
 */
test("the web app does not depend on secure-context-only browser APIs", () => {
  const source = readFileSync(join(process.cwd(), "apps/web/public/app.js"), "utf8");
  // Scan code, not prose: a comment explaining why an API is unsafe must not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // crypto.subtle has no legitimate use here at all.
  assert.ok(!/crypto\.subtle/.test(code), "crypto.subtle is unavailable over plain HTTP");

  // crypto.randomUUID may only be feature-detected inside the request-id helper, never called
  // elsewhere - everywhere else it is simply undefined outside a secure context.
  const start = code.indexOf("function newRequestId()");
  assert.ok(start >= 0, "the request id helper must exist");
  const end = code.indexOf("\n}", start) + 2;
  const body = code.slice(start, end);
  for (const match of code.matchAll(/crypto\.randomUUID/g)) {
    assert.ok((match.index ?? 0) >= start && (match.index ?? 0) < end, "crypto.randomUUID may only be used inside the guarded request-id helper");
  }
  assert.ok(/typeof crypto\.randomUUID === "function"/.test(body), "the helper must detect the API rather than assume it");

  // Run the real helper with a crypto that has no randomUUID, which is what an insecure context
  // actually looks like, and check the id the server will accept.
  const context = {
    crypto: { getRandomValues: (target: Uint8Array) => { for (let i = 0; i < target.length; i += 1) target[i] = (i * 37 + 11) % 256; return target; } },
    Uint8Array, Array, String,
  };
  const generated = runInNewContext(`${body}\nnewRequestId()`, context) as string;
  assert.match(generated, /^web-[a-z0-9-]+$/);
  assert.match(generated, /^[A-Za-z0-9._:-]{1,128}$/, "the server rejects ids outside this shape");
});
