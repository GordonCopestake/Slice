#!/usr/bin/env node
// Drive a real Chromium instance over the DevTools protocol, with no third-party dependency.
//
// This exists because two Phase 3/4 defects reached main only through a real browser: a route the
// HTTP layer never exposed, and crypto.randomUUID being undefined outside a secure context. Parsing
// app.js as JavaScript passed both times. Node's built-in WebSocket keeps the harness small.
//
//   node tools/cdp.mjs nav <url>        open the url and install the error collector
//   node tools/cdp.mjs eval <expr>      evaluate JS in the page, await promises
//   node tools/cdp.mjs errors           dump page exceptions and console errors
//   node tools/cdp.mjs shot <file>      write a screenshot
//
// Chromium must already be running with --remote-debugging-port (see CDP_PORT, default 9333).

const PORT = Number(process.env.CDP_PORT ?? "9333");
const BASE = `http://127.0.0.1:${PORT}`;

const COLLECTOR = `
  window.__sliceErrors = window.__sliceErrors || [];
  window.addEventListener("error", (event) => {
    window.__sliceErrors.push({ kind: "error", message: String(event.message), source: String(event.filename), line: event.lineno, col: event.colno });
  });
  window.addEventListener("unhandledrejection", (event) => {
    window.__sliceErrors.push({ kind: "rejection", message: String(event.reason && event.reason.message || event.reason) });
  });
  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = function (...args) {
      window.__sliceErrors.push({ kind: "console." + level, message: args.map((a) => String(a)).join(" ") });
      return original.apply(console, args);
    };
  }
`;

async function httpJson(path, method = "GET") {
  const response = await fetch(`${BASE}${path}`, { method });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status} for ${path}: ${await response.text()}`);
  return response.json();
}

async function pageTarget() {
  const targets = await httpJson("/json/list");
  const existing = targets.find((target) => target.type === "page" && !target.url.startsWith("devtools://"));
  if (existing) return existing;
  return httpJson("/json/new?about:blank", "PUT");
}

class Cdp {
  constructor(target) {
    this.target = target;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.socket = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP websocket failed; is chromium running?")), { once: true });
    });
    this.socket.addEventListener("message", (frame) => {
      const message = JSON.parse(String(frame.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (waiter !== undefined) {
          this.pending.delete(message.id);
          if (message.error !== undefined) waiter.reject(new Error(`${message.error.message}: ${JSON.stringify(message.error.data ?? "")}`));
          else waiter.resolve(message.result);
        }
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const target = await pageTarget();
  const cdp = new Cdp(target);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: COLLECTOR });

  if (command === "nav") {
    await cdp.send("Page.navigate", { url: rest[0] });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const info = await cdp.send("Runtime.evaluate", { expression: "({ href: location.href, title: document.title, ready: document.readyState })", returnByValue: true });
    console.log(JSON.stringify(info.result.value, null, 2));
  } else if (command === "eval") {
    const result = await cdp.send("Runtime.evaluate", {
      expression: rest.join(" "),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      console.log(JSON.stringify({ thrown: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }, null, 2));
    } else {
      console.log(JSON.stringify(result.result.value, null, 2));
    }
  } else if (command === "errors") {
    const collected = await cdp.send("Runtime.evaluate", { expression: "window.__sliceErrors ?? []", returnByValue: true });
    const log = cdp.events.filter((event) => event.method === "Log.entryAdded").map((event) => event.params.entry);
    console.log(JSON.stringify({ page: collected.result.value, browserLog: log }, null, 2));
  } else if (command === "shot") {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(rest[0], Buffer.from(shot.data, "base64"));
    console.log(rest[0]);
  } else {
    console.log("usage: cdp.mjs nav <url> | eval <expr> | errors | shot <file>");
  }
  cdp.close();
}

main().catch((error) => { console.error(String(error.message ?? error)); process.exit(1); });
