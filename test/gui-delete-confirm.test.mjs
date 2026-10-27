// Delete confirmation must survive the same list refresh that replaces #sessions.
// The page script runs for real; DOM and fetch are doubles.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const HTML = fs.readFileSync(new URL("../src/gui.html", import.meta.url), "utf8");
const SID = "44444444-4444-4444-8444-444444444444";

function openGui() {
  const nodes = new Map();
  const element = () => {
    const listeners = new Map();
    const node = {
      value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, open: false,
      dataset: {}, style: {}, id: "",
      classList: { add() {}, remove() {}, toggle() {} },
      querySelectorAll: () => [],
      querySelector: () => ({ innerHTML: "", textContent: "" }),
      addEventListener: (event, handler) => listeners.set(event, handler),
      showModal() { this.open = true; },
      close() { this.open = false; },
      focus() {},
      async fire(event) { await listeners.get(event)?.({ preventDefault() {}, stopPropagation() {}, target: node }); },
    };
    return node;
  };
  for (const match of HTML.split("<script>")[0].matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], element());
  const calls = [];
  const context = vm.createContext({
    document: {
      querySelector: (selector) => nodes.get(selector.slice(1)) || null,
      querySelectorAll: () => [],
      getElementById: (id) => nodes.get(id) || null,
      createElement: element,
      body: { appendChild: (node) => nodes.set(node.id, node) },
    },
    setTimeout: () => 0,
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (route, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ route, body, method: opts.method || "GET", headers: opts.headers || {} });
      let data;
      if (route === "/api/status") data = { apiKey: "gui-test-key", origin: "http://127.0.0.1:20140", accounts: [] };
      else if (route === "/api/sessions") data = { archiveDir: "/tmp/archive", sessions: [], groups: [] };
      else if (route === "/api/pool/bindings") data = { bindings: [] };
      else if (route === "/api/archive/stats") data = { total: 1, models: 1, archiveDir: "/tmp/archive" };
      else if (route === "/api/pool/delete") data = { ok: true, removed: body.sessionIds, notFound: 0 };
      else data = { installed: false, running: false, done: 0 };
      return { json: async () => data };
    },
  });
  vm.runInContext(HTML.match(/<script>([\s\S]*?)<\/script>/)[1], context, { filename: "gui.html" });
  return { get: (id) => nodes.get(id), calls, context };
}

test("the delete prompt is outside the list that a refresh replaces", () => {
  const markup = HTML.split("<script>")[0];
  assert.ok(markup.indexOf('id="deleteConfirm"') > markup.indexOf("</main>"));
  assert.match(markup, /type="button"[^>]*id="selDel"/);
  assert.match(HTML, /type="button"[^>]*del-btn/);
});

test("opening delete stays open across a list refresh, until the operator answers", async () => {
  const gui = await (async () => {
    const opened = openGui();
    await new Promise(setImmediate);
    opened.calls.length = 0;
    return opened;
  })();
  assert.equal(typeof gui.context.deleteSessions, "function");

  const pending = gui.context.deleteSessions([SID]);
  const dialog = gui.get("deleteConfirm");
  assert.equal(dialog.open, true);
  assert.match(gui.get("deleteConfirmText").textContent, /确认删除 1 条 session/);

  await gui.get("refresh").fire("click");
  assert.equal(dialog.open, true, "refresh re-renders the session list and must not close the prompt");
  assert.match(gui.get("deleteConfirmText").textContent, /确认删除 1 条 session/);
  assert.equal(gui.calls.some((call) => call.route === "/api/pool/delete"), false);

  await gui.get("deleteConfirmCancel").fire("click");
  await pending;
  assert.equal(dialog.open, false);
  assert.equal(gui.calls.some((call) => call.route === "/api/pool/delete"), false);
});

test("confirming delete sends the session id and closes the prompt", async () => {
  const gui = openGui();
  await new Promise(setImmediate);
  gui.calls.length = 0;

  const pending = gui.context.deleteSessions([SID, SID]);
  assert.equal(gui.get("deleteConfirm").open, true);
  await gui.get("deleteConfirmOk").fire("click");
  await pending;

  assert.equal(gui.get("deleteConfirm").open, false);
  const posted = gui.calls.find((call) => call.route === "/api/pool/delete");
  assert.ok(posted);
  assert.deepEqual(posted.body, { sessionIds: [SID] });
  assert.equal(posted.headers.Authorization, "Bearer gui-test-key");
});

test("delete with nothing selected does not open the prompt", async () => {
  const gui = openGui();
  await new Promise(setImmediate);
  await gui.get("selDel").fire("click");
  assert.equal(gui.get("deleteConfirm").open, false);
});
