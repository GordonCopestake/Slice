import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";
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
