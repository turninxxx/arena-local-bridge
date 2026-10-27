// The manual-add forms post through the same handler the page ships. DOM and
// fetch are doubles; nothing here touches the archive or Arena.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const HTML = fs.readFileSync(new URL("../src/gui.html", import.meta.url), "utf8");
const SID = "44444444-4444-4444-8444-444444444444";

async function openGui({ failMessage = "" } = {}) {
  const nodes = new Map();
  const element = () => {
    const listeners = new Map();
    const node = {
      value: "", textContent: "", innerHTML: "", disabled: false, hidden: false, dataset: {}, style: {}, id: "",
      classList: { add() {}, remove() {}, toggle() {} },
      querySelectorAll: () => [],
      querySelector: () => ({ innerHTML: "", textContent: "" }),
      addEventListener: (event, handler) => listeners.set(event, handler),
      focus() {},
      async fire(event) { await listeners.get(event)?.({ preventDefault() {}, target: node }); },
    };
    return node;
  };
  for (const match of HTML.split("<script>")[0].matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], element());
  const calls = [];
  let added = null;
  const context = vm.createContext({
    document: {
      querySelector: (selector) => nodes.get(selector.slice(1)) || null,
      querySelectorAll: () => [],
      getElementById: (id) => nodes.get(id) || null,
      createElement: element,
      body: { appendChild: (node) => nodes.set(node.id, node) },
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async (route, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ route, body, method: opts.method || "GET", headers: opts.headers || {} });
      let data;
      if (route === "/api/archive/sessions") {
        if (failMessage) data = { error: { message: failMessage, code: "already_present" } };
        else {
          added = {
            sessionId: SID,
            model: body.model || "未识别",
            title: body.model || "未识别",
            url: `https://arena.ai/agent/${SID}`,
            email: "",
          };
          data = { ok: true, sessionId: SID, model: added.model, url: added.url, title: added.title };
        }
      } else if (route === "/api/status") {
        data = { apiKey: "gui-test-key", origin: "http://127.0.0.1:20140", accounts: [] };
      } else if (route === "/api/sessions") {
        data = added
          ? { archiveDir: "/tmp/archive", sessions: [added], groups: [{ model: added.model, ok: 1, total: 1, sessions: [added] }] }
          : { archiveDir: "/tmp/archive", sessions: [], groups: [] };
      } else if (route === "/api/pool/bindings") data = { bindings: [] };
      else if (route === "/api/archive/stats") data = { total: added ? 1 : 0, models: added ? 1 : 0, archiveDir: "/tmp/archive" };
      else data = { installed: false, running: false, done: 0 };
      return { json: async () => data };
    },
  });
  vm.runInContext(HTML.match(/<script>([\s\S]*?)<\/script>/)[1], context, { filename: "gui.html" });
  await new Promise(setImmediate);
  calls.length = 0;
  return { get: (id) => nodes.get(id), calls };
}

test("the archive form and the harvest form both exist", async () => {
  const gui = await openGui();
  assert.ok(gui.get("addSessionForm"));
  assert.ok(gui.get("hvAddSessionForm"));
  assert.equal(gui.get("addSessionBtn").disabled, false);
  assert.equal(gui.get("hvAddSessionBtn").disabled, false);
});

test("an empty archive form stays local and says what to paste", async () => {
  const gui = await openGui();
  await gui.get("addSessionForm").fire("submit");
  assert.equal(gui.calls.some((call) => call.route === "/api/archive/sessions"), false);
  assert.match(gui.get("addSessionStatus").textContent, /UUID/);
  assert.equal(gui.get("addSessionBtn").disabled, false);
});

test("the archive form posts the pasted session and shows it in the list", async () => {
  const gui = await openGui();
  gui.get("addSession").value = ` https://arena.ai/agent/${SID} `;
  gui.get("addModel").value = "gpt-5";
  gui.get("addNote").value = "手抄";
  await gui.get("addSessionForm").fire("submit");

  const post = gui.calls.find((call) => call.route === "/api/archive/sessions");
  assert.ok(post);
  assert.equal(post.method, "POST");
  assert.equal(post.headers.Authorization, "Bearer gui-test-key");
  assert.deepEqual(post.body, { session: `https://arena.ai/agent/${SID}`, model: "gpt-5", note: "手抄" });
  assert.equal(gui.get("addSession").value, "");
  assert.equal(gui.get("addModel").value, "");
  assert.equal(gui.get("addNote").value, "");
  assert.match(gui.get("addSessionStatus").textContent, /已加入归档/);
  assert.match(gui.get("sessions").innerHTML, new RegExp(SID));
  assert.match(gui.get("pickList").innerHTML, /gpt-5/);
  assert.equal(gui.get("addSessionBtn").disabled, false);
});

test("a server rejection is shown and the typed session is kept", async () => {
  const gui = await openGui({ failMessage: "该 session 已在归档中：" + SID });
  gui.get("hvAddSession").value = SID;
  gui.get("hvAddModel").value = "gpt-5";
  await gui.get("hvAddSessionForm").fire("submit");

  const post = gui.calls.find((call) => call.route === "/api/archive/sessions");
  assert.deepEqual(post.body, { session: SID, model: "gpt-5", note: "" });
  assert.match(gui.get("hvAddSessionStatus").textContent, /已在归档中/);
  assert.equal(gui.get("hvAddSession").value, SID);
  assert.equal(gui.get("hvAddSessionBtn").disabled, false);
});
