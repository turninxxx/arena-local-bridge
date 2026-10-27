// E2E over REAL HTTP: real createServer, real sockets, real framing — the
// bridge is a programmable fake (see ./helper.mjs). These tests cover the one
// layer nothing else touches: routing and its order, auth, the loopback
// defense, OpenAI response shapes, SSE framing, validation and error shapes,
// rate limiting, and the busy-409 window. They assert PROTOCOL and system
// behavior, never model intelligence.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { VERSION } from "../../src/version.mjs";
import { startE2E, httpRequest, authHeaders, waitFor, BRIDGE_KEY, SESSION_ID } from "./helper.mjs";

const CHAT = { method: "POST", reqPath: "/v1/chat/completions" };
const chatBody = (extra = {}) => ({
  model: SESSION_ID,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("open edges (no key required)", () => {
  test("/health answers without a key and leaks no secret", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { reqPath: "/health" });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.ok(Array.isArray(res.json.accounts));
      assert.equal(res.json.accounts[0].email, "acct@test.local");
      assert.equal(res.json.accounts[0].quota, null, "a fresh pool state has no cached reading yet");
      assert.equal(res.json.bridgeKey, undefined);
      assert.equal(res.json.apiKey, undefined);
      assert.ok(res.json.endpoints.includes("POST /v1/responses"));
      assert.ok(res.json.endpoints.includes("POST /v1/messages"));
      assert.ok(res.json.endpoints.includes("POST /v1/chat/completions"));
    } finally { await e2e.close(); }
  });

  test("the GUI page is served without a key", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { reqPath: "/" });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.text, /\/v1\/responses/);
      assert.match(res.text, /\/v1\/messages/);
    } finally { await e2e.close(); }
  });
});

describe("the loopback defense", () => {
  test("a foreign Host header is rejected before anything else", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        reqPath: "/health",
        headers: { Host: "attacker.example" },
      });
      assert.equal(res.status, 403);
    } finally { await e2e.close(); }
  });

  test("a local Host with a foreign Origin is rejected too", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        reqPath: "/health",
        headers: { Host: `127.0.0.1:${e2e.port}`, Origin: "https://attacker.example" },
      });
      assert.equal(res.status, 403);
    } finally { await e2e.close(); }
  });

  test("/api/status hands out the key only while the bind is loopback", async () => {
    const local = await startE2E();
    try {
      const res = await httpRequest(local.port, { reqPath: "/api/status", headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.json.apiKey, BRIDGE_KEY);
      assert.equal(res.json.responsesEndpoint, `http://127.0.0.1:${local.port}/v1/responses`);
      assert.equal(res.json.messagesEndpoint, `http://127.0.0.1:${local.port}/v1/messages`);
    } finally { await local.close(); }

    const foreign = await startE2E({ config: { host: "0.0.0.0", bindHost: "127.0.0.1" } });
    try {
      const res = await httpRequest(foreign.port, { reqPath: "/api/status", headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.json.apiKey, "", "a non-loopback HOST can be spoofed — the key must not travel");
    } finally { await foreign.close(); }
  });
});

describe("bridge key auth", () => {
  test("keyed routes reject a missing or wrong key", async () => {
    const e2e = await startE2E();
    try {
      const missing = await httpRequest(e2e.port, { reqPath: "/v1/models" });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.message, "Invalid bridge key");
      const wrong = await httpRequest(e2e.port, { reqPath: "/v1/models", headers: { Authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401);
    } finally { await e2e.close(); }
  });

  test("/v1/models lists the archived session plus the ping probe", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { reqPath: "/v1/models", headers: authHeaders() });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "list");
      const ids = res.json.data.map((m) => m.id);
      assert.ok(ids.includes(SESSION_ID));
      assert.ok(ids.includes("ping"));
    } finally { await e2e.close(); }
  });
});

describe("POST /v1/chat/completions — non-streaming", () => {
  test("a UUID model routes to converse with the session id, headers included", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders({ "x-arena-idempotency-key": "e2e-key-1" }),
        body: chatBody(),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "chat.completion");
      assert.equal(res.json.choices[0].message.role, "assistant");
      assert.ok(res.json.usage);
      assert.ok(res.headers["x-arena-bridge-request-id"]);
      assert.equal(res.headers["x-arena-bridge-version"], VERSION);

      assert.equal(e2e.bridge.calls.converse.length, 1);
      const call = e2e.bridge.calls.converse[0];
      assert.equal(call.sessionId, SESSION_ID);
      assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }]);
      // The HTTP layer's one idempotency duty: hand the header to the bridge
      // intact. (Deduping itself lives in the bridge and is unit-tested there.)
      assert.equal(call.opts.headers["x-arena-idempotency-key"], "e2e-key-1");
      assert.equal(call.opts.headers.authorization, `Bearer ${BRIDGE_KEY}`);
    } finally { await e2e.close(); }
  });

  test("a bridge failure surfaces error.status, the code and a request_id", async () => {
    const e2e = await startE2E({
      bridge: {
        converse: async () => {
          throw Object.assign(new Error("session gone"), { status: 503, code: "session_gone" });
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.type, "arena_agent_error");
      assert.equal(res.json.error.code, "session_gone");
      assert.ok(res.json.error.request_id);
    } finally { await e2e.close(); }
  });

  test("a bridge failure without a status falls back to 502", async () => {
    const e2e = await startE2E({ bridge: { converse: async () => { throw new Error("boom"); } } });
    try {
      const res = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(res.status, 502);
      assert.equal(res.json.error.message, "boom");
    } finally { await e2e.close(); }
  });

  test("no active session is an actionable 409, not a silent fallback", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: { messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "no_active_session");
      assert.equal(e2e.bridge.calls.runAgent.length, 0, "it must never fall through to session creation");
    } finally { await e2e.close(); }
  });

  test("a non-UUID model falls through to the legacy runAgent flow", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: chatBody({ model: "agent" }),
      });
      assert.equal(res.status, 200);
      assert.equal(e2e.bridge.calls.runAgent.length, 1);
      assert.equal(e2e.bridge.calls.converse.length, 0);
    } finally { await e2e.close(); }
  });
});

describe("POST /v1/chat/completions — streaming (SSE)", () => {
  test("the stream opens immediately, carries deltas, and closes with [DONE]", async () => {
    const e2e = await startE2E({
      bridge: {
        converse: async (_sid, _body, opts = {}) => {
          // Simulate the bridge pushing a delta out of the page mid-turn.
          if (opts.onDelta) opts.onDelta("partial ");
          return {
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "partial answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: chatBody({ stream: true }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      const frames = res.text.split("\n\n").filter((f) => f.startsWith("data: "));
      const events = frames
        .filter((f) => f !== "data: [DONE]")
        .map((f) => JSON.parse(f.slice(6)));
      assert.equal(events[0].choices[0].delta.role, "assistant", "first frame is a valid chunk, not a comment");
      const contents = events.map((e) => e.choices[0].delta.content).filter(Boolean);
      assert.ok(contents.includes("partial "), "a mid-turn push reaches the client as its own chunk");
      const finish = events.find((e) => e.choices[0].finish_reason);
      assert.equal(finish.choices[0].finish_reason, "stop");
      assert.equal(frames.at(-1), "data: [DONE]", "the last data frame is the bare [DONE] sentinel");
      assert.ok(res.text.endsWith("data: [DONE]\n\n"));
    } finally { await e2e.close(); }
  });
});

describe("validation and error shapes", () => {
  test("an invalid body is a 400 with the OpenAI error shape and a request_id", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders(),
        body: { model: SESSION_ID, messages: [] },
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.type, "invalid_request_error");
      assert.ok(res.json.error.request_id);
    } finally { await e2e.close(); }
  });

  test("unparseable JSON is a 400, not a crash", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        ...CHAT,
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: "{not json",
      });
      assert.equal(res.status, 400);
      assert.ok(res.json.error.message);
    } finally { await e2e.close(); }
  });

  test("a wrong route is a self-documenting 404", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, { method: "GET", reqPath: "/v1/chat/completions", headers: authHeaders() });
      assert.equal(res.status, 404);
      assert.equal(res.json.error.method, "GET");
      assert.equal(res.json.error.path, "/v1/chat/completions");
      assert.match(res.json.error.hint, /POST/);
      assert.match(res.json.error.hint, /\/v1\/responses/);
      assert.match(res.json.error.hint, /\/v1\/messages/);
    } finally { await e2e.close(); }
  });

  test("the rate limiter answers 429 with Retry-After on the real route", async () => {
    const e2e = await startE2E({ config: { rateLimitRpm: 1 } });
    try {
      const first = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(first.status, 200);
      const second = await httpRequest(e2e.port, { ...CHAT, headers: authHeaders(), body: chatBody() });
      assert.equal(second.status, 429);
      assert.equal(second.json.error.type, "rate_limited");
      assert.ok(Number(second.headers["retry-after"]) > 0);
    } finally { await e2e.close(); }
  });
});

describe("operator endpoints over real HTTP", () => {
  test("/api/pool/verify drives one turn; a second while it runs is 409 busy", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const e2e = await startE2E({
      bridge: {
        converse: async (sessionId, body, opts) => {
          e2e.bridge.calls.converse.push({ sessionId, body, opts });
          await gate;
          return {
            choices: [{ message: { role: "assistant", content: "OK" } }],
          };
        },
      },
    });
    try {
      const first = httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/pool/verify",
        headers: authHeaders(), body: { sessionId: SESSION_ID },
      });
      await waitFor(() => e2e.bridge.calls.converse.length === 1);
      const second = await httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/pool/verify",
        headers: authHeaders(), body: { sessionId: SESSION_ID },
      });
      assert.equal(second.status, 409);
      assert.equal(second.json.error.code, "busy");
      release();
      const done = await first;
      assert.equal(done.status, 200);
      assert.equal(done.json.alive, true);
      assert.equal(done.json.sessionId, SESSION_ID);
    } finally { await e2e.close(); }
  });

  test("/api/account/quota records the reading into pool state", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/account/quota", headers: authHeaders(), body: {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.email, "acct@test.local");
      assert.equal(res.json.percent, 42);
      assert.ok(
        existsSync(path.join(e2e.config.dataDir, "pool-state.json")),
        "the cached reading must survive a restart",
      );
    } finally { await e2e.close(); }
  });

  test("a busy rejection from the bridge's own gate surfaces as 409, not 500", async () => {
    const e2e = await startE2E({
      bridge: {
        quotaSnapshot: async () => {
          throw Object.assign(new Error("A turn is in flight; retry when it finishes."), {
            status: 409,
            code: "busy",
          });
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST", reqPath: "/api/account/quota", headers: authHeaders(), body: {},
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "busy");
    } finally { await e2e.close(); }
  });
});

describe("GET /api/mcp/workspaces — recent candidates, never an automatic choice", () => {
  test("returns the newest ten distinct absolute paths and timestamps, without transcript metadata", async (t) => {
    const ctx = await startE2E();
    t.after(() => ctx.close());
    const sessionsRoot = path.join(ctx.config.dataDir, "codex-sessions");
    ctx.config.codexSessionsDir = sessionsRoot;
    mkdirSync(path.join(sessionsRoot, "nested"), { recursive: true });
    const fixtures = [
      ["/projects/newest", 12], ["D:\\projects\\one", 11], ["/projects/newest", 10],
      ["/projects/two", 9], ["/projects/three", 8], ["/projects/four", 7],
      ["/projects/five", 6], ["/projects/six", 5], ["/projects/seven", 4],
      ["/projects/eight", 3], ["/projects/nine", 2], ["/projects/ten", 1],
      ["/projects/eleven", 0], ["relative/project", 13], ["", 14],
    ];
    for (const [index, [cwd, second]] of fixtures.entries()) {
      const file = path.join(sessionsRoot, "nested", `private-session-${index}.jsonl`);
      writeFileSync(file, JSON.stringify({ cwd, message: "private transcript content" }));
      const stamp = new Date(Date.UTC(2026, 8, 30, 0, 0, second));
      utimesSync(file, stamp, stamp);
    }
    const res = await httpRequest(ctx.port, { reqPath: "/api/mcp/workspaces", headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, [
      { workspace: "/projects/newest", lastWriteAt: "2026-09-30T00:00:12.000Z" },
      { workspace: "D:\\projects\\one", lastWriteAt: "2026-09-30T00:00:11.000Z" },
      { workspace: "/projects/two", lastWriteAt: "2026-09-30T00:00:09.000Z" },
      { workspace: "/projects/three", lastWriteAt: "2026-09-30T00:00:08.000Z" },
      { workspace: "/projects/four", lastWriteAt: "2026-09-30T00:00:07.000Z" },
      { workspace: "/projects/five", lastWriteAt: "2026-09-30T00:00:06.000Z" },
      { workspace: "/projects/six", lastWriteAt: "2026-09-30T00:00:05.000Z" },
      { workspace: "/projects/seven", lastWriteAt: "2026-09-30T00:00:04.000Z" },
      { workspace: "/projects/eight", lastWriteAt: "2026-09-30T00:00:03.000Z" },
      { workspace: "/projects/nine", lastWriteAt: "2026-09-30T00:00:02.000Z" },
    ]);
  });

  test("a missing Codex directory is an empty list and still requires the bridge key", async (t) => {
    const ctx = await startE2E();
    t.after(() => ctx.close());
    ctx.config.codexSessionsDir = path.join(ctx.config.dataDir, "absent-codex-sessions");
    for (const headers of [{}, { Authorization: "Bearer wrong-key" }]) {
      const denied = await httpRequest(ctx.port, { reqPath: "/api/mcp/workspaces", headers });
      assert.equal(denied.status, 401);
    }
    const res = await httpRequest(ctx.port, { reqPath: "/api/mcp/workspaces", headers: authHeaders() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, []);
  });
});

describe("POST /api/mcp/reinject — the manual entry for a session whose workspace arrived late", () => {
  // Nothing is injected by the call itself: it ARMS the next real turn, which
  // is the only thing that carries the preamble to the model.
  const outcome = { injected: false, pending: true, reason: "armed: the next turn re-injects", workspace: "/w", workspaceFrom: "request-header" };

  test("it defaults to the active session and returns what happened", async (t) => {
    const calls = [];
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async (sessionId, headers) => { calls.push({ sessionId, headers }); return outcome; } } });
    t.after(() => ctx.close());
    await httpRequest(ctx.port, { method: "POST", reqPath: "/api/active-session", headers: authHeaders({ "Content-Type": "application/json" }), body: { sessionId: SESSION_ID } });
    const res = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders({ "Content-Type": "application/json" }), body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.sessionId), [SESSION_ID]);
    assert.equal(res.json.sessionId, SESSION_ID);
    assert.equal(res.json.pending, true);
    assert.equal(res.json.workspace, "/w");
    assert.equal(res.json.hint, "");
  });

  test("the x-arena-workspace header is forwarded — it is the documented contract", async (t) => {
    const calls = [];
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async (sessionId, headers) => { calls.push({ sessionId, headers }); return outcome; } } });
    t.after(() => ctx.close());
    await httpRequest(ctx.port, {
      method: "POST",
      reqPath: "/api/mcp/reinject",
      headers: authHeaders({ "Content-Type": "application/json", "x-arena-workspace": "/from-header" }),
      body: { sessionId: SESSION_ID, workspace: "/from-body" },
    });
    assert.equal(calls[0].headers["x-arena-workspace"], "/from-header", "the header wins over the body field");
  });

  test("the GUI's explicit workspace is forwarded to the selected Session", async (t) => {
    const calls = [];
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async (sessionId, headers) => {
      calls.push({ sessionId, headers });
      return { ...outcome, workspace: headers["x-arena-workspace"] };
    } } });
    t.after(() => ctx.close());
    const res = await httpRequest(ctx.port, {
      method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders(),
      body: { sessionId: SESSION_ID, workspace: "/projects/selected" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.workspace, "/projects/selected");
    assert.deepEqual(calls, [{ sessionId: SESSION_ID, headers: { "x-arena-workspace": "/projects/selected" } }]);
  });

  test("a refusal comes back with the reason AND how to fix it", async (t) => {
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async () => ({ injected: false, pending: false, reason: "no workspace recognized", workspace: "", workspaceFrom: "none" }) } });
    t.after(() => ctx.close());
    const res = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders({ "Content-Type": "application/json" }), body: { sessionId: SESSION_ID } });
    assert.equal(res.status, 200);
    assert.equal(res.json.injected, false);
    assert.equal(res.json.pending, false);
    assert.equal(res.json.reason, "no workspace recognized");
    // Ticket 24: this route's usual caller is the GUI button, which has no
    // headers to set, so the remedies it can actually perform come first.
    assert.match(res.json.hint, /mcp-workspace\.txt/);
    assert.match(res.json.hint, /x-arena-workspace/);
  });

  test("no session anywhere is an actionable 400, and the key still guards it", async (t) => {
    const ctx = await startE2E({ bridge: { reinjectLocalCapability: async () => outcome } });
    t.after(() => ctx.close());
    const res = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: authHeaders({ "Content-Type": "application/json" }), body: { sessionId: "" } });
    assert.equal(res.status, 400);
    const noKey = await httpRequest(ctx.port, { method: "POST", reqPath: "/api/mcp/reinject", headers: { "Content-Type": "application/json" }, body: { sessionId: SESSION_ID } });
    assert.equal(noKey.status, 401);
  });
});

function parseSse(text) {
  const events = [];
  for (const frame of text.split(/\n\n/)) {
    const trimmed = frame.trim();
    if (!trimmed || trimmed.startsWith(":")) continue;
    let eventName = "";
    const data = [];
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (!data.length) continue;
    events.push({ event: eventName, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

const TOOL_REPLY = {
  object: "chat.completion",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_ls", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};

describe("POST /v1/responses", () => {
  test("bearer auth translates input into the chat driver and maps a tool call back", async () => {
    const seen = [];
    const e2e = await startE2E({
      bridge: {
        converse: async (sessionId, body) => {
          seen.push({ sessionId, body });
          return TOOL_REPLY;
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/responses",
        headers: authHeaders(),
        body: {
          model: SESSION_ID,
          instructions: "be brief",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] }],
          tools: [{ type: "function", name: "Bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } }],
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "response");
      assert.equal(res.json.status, "completed");
      assert.equal(res.json.store, false);
      const call = res.json.output.find((item) => item.type === "function_call");
      assert.equal(call.name, "Bash");
      assert.equal(call.call_id, "call_ls");
      assert.equal(call.arguments, "{\"command\":\"ls\"}");
      assert.equal(seen[0].sessionId, SESSION_ID);
      assert.equal(seen[0].body.messages[0].role, "system");
      assert.equal(seen[0].body.messages[1].content, "list files");
      assert.equal(seen[0].body.tools[0].function.name, "Bash");
      assert.equal(e2e.bridge.calls.runAgent.length, 0);
    } finally { await e2e.close(); }
  });

  test("a Codex model name uses the GUI session, and x-api-key is accepted", async () => {
    const e2e = await startE2E();
    try {
      const picked = await httpRequest(e2e.port, { method: "POST", reqPath: "/api/active-session", body: { sessionId: SESSION_ID } });
      assert.equal(picked.status, 200);
      const res = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/responses",
        headers: { "x-api-key": BRIDGE_KEY },
        body: { model: "gpt-5.4", input: "hello" },
      });
      assert.equal(res.status, 200);
      assert.equal(e2e.bridge.calls.converse[0].sessionId, SESSION_ID);
      assert.equal(e2e.bridge.calls.converse[0].body.model, "active");
      assert.equal(e2e.bridge.calls.runAgent.length, 0);
    } finally { await e2e.close(); }
  });

  test("previous_response_id stitches a tool result onto the stored transcript", async () => {
    const seen = [];
    const e2e = await startE2E({
      bridge: {
        converse: async (sessionId, body) => {
          seen.push(body.messages);
          if (body.messages.some((message) => message.role === "tool")) {
            return {
              object: "chat.completion",
              choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          }
          return TOOL_REPLY;
        },
      },
    });
    try {
      const first = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/responses",
        headers: authHeaders(),
        body: { model: SESSION_ID, input: "list files", tools: [{ type: "function", name: "Bash", parameters: { type: "object" } }] },
      });
      assert.equal(first.status, 200);
      const second = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/responses",
        headers: authHeaders(),
        body: {
          model: SESSION_ID,
          previous_response_id: first.json.id,
          input: [{ type: "function_call_output", call_id: "call_ls", output: "a.txt" }],
        },
      });
      assert.equal(second.status, 200);
      assert.equal(second.json.output[0].content[0].text, "done");
      const roles = seen[1].map((message) => message.role);
      assert.deepEqual(roles, ["user", "assistant", "tool"]);
      assert.equal(seen[1][0].content, "list files");
      assert.equal(seen[1][2].content, "a.txt");
      assert.equal(seen[1][2].tool_call_id, "call_ls");
    } finally { await e2e.close(); }
  });

  test("streaming emits Responses SSE and keeps the chat route's chunks unchanged", async () => {
    const e2e = await startE2E({
      bridge: {
        converse: async (_sid, _body, opts = {}) => {
          if (opts.onDelta) opts.onDelta("partial ");
          return {
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "partial answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/responses",
        headers: authHeaders(),
        body: { model: SESSION_ID, input: "hi", stream: true },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      const events = parseSse(res.text);
      const deltas = events.filter((event) => event.data.type === "response.output_text.delta").map((event) => event.data.delta);
      assert.deepEqual(deltas, ["partial ", "answer"]);
      assert.equal(events.at(-1).data.type, "response.completed");
      assert.equal(events.at(-1).data.response.status, "completed");
    } finally { await e2e.close(); }
  });

  test("ping does not drive the browser", async () => {
    const e2e = await startE2E();
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/responses",
        headers: authHeaders(),
        body: { model: "ping", input: "hi" },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.output[0].content[0].text, "pong");
      assert.equal(e2e.bridge.calls.converse.length, 0);
      assert.equal(e2e.bridge.calls.runAgent.length, 0);
    } finally { await e2e.close(); }
  });
});

describe("POST /v1/messages", () => {
  test("x-api-key auth maps Anthropic messages and returns tool_use", async () => {
    const seen = [];
    const e2e = await startE2E({
      bridge: {
        converse: async (sessionId, body) => {
          seen.push({ sessionId, body });
          return TOOL_REPLY;
        },
      },
    });
    try {
      const missing = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        body: { model: SESSION_ID, max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error.type, "authentication_error");
      const res = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        headers: { "x-api-key": BRIDGE_KEY, "anthropic-version": "2023-06-01" },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          system: "be brief",
          messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
          tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
        },
      });
      assert.equal(res.status, 409);
      assert.equal(res.json.error.code, "no_active_session");
      const picked = await httpRequest(e2e.port, { method: "POST", reqPath: "/api/active-session", body: { sessionId: SESSION_ID } });
      assert.equal(picked.status, 200);
      const ok = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        headers: { Authorization: "Bearer wrong", "x-api-key": BRIDGE_KEY },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          system: "be brief",
          messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
          tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
        },
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.type, "message");
      assert.equal(ok.json.stop_reason, "tool_use");
      assert.equal(ok.json.content[0].type, "tool_use");
      assert.equal(ok.json.content[0].id, "call_ls");
      assert.deepEqual(ok.json.content[0].input, { command: "ls" });
      assert.equal(seen[0].sessionId, SESSION_ID);
      assert.equal(seen[0].body.messages[0].content, "be brief");
      assert.equal(seen[0].body.messages[1].content, "list files");
      assert.equal(seen[0].body.tools[0].function.name, "Bash");
    } finally { await e2e.close(); }
  });

  test("x-claude-code-session-id keeps a later active turn on the same session", async () => {
    const e2e = await startE2E();
    try {
      const headers = { "x-api-key": BRIDGE_KEY, "x-claude-code-session-id": "claude-session-1" };
      const first = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        headers,
        body: { model: SESSION_ID, max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(first.status, 200);
      const second = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        headers,
        body: { model: "claude-sonnet-4-5", max_tokens: 8, messages: [{ role: "user", content: "next" }] },
      });
      assert.equal(second.status, 200);
      assert.deepEqual(e2e.bridge.calls.converse.map((call) => call.sessionId), [SESSION_ID, SESSION_ID]);
    } finally { await e2e.close(); }
  });

  test("streaming emits Anthropic SSE through message_stop", async () => {
    const e2e = await startE2E({
      bridge: {
        converse: async (_sid, _body, opts = {}) => {
          if (opts.onDelta) opts.onDelta("Hi");
          return {
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "Hi there" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          };
        },
      },
    });
    try {
      const res = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages?beta=true",
        headers: authHeaders(),
        body: { model: SESSION_ID, max_tokens: 16, messages: [{ role: "user", content: "hi" }], stream: true },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      const events = parseSse(res.text);
      assert.equal(events[0].event, "message_start");
      const text = events.filter((event) => event.data.delta?.type === "text_delta").map((event) => event.data.delta.text);
      assert.deepEqual(text, ["Hi", " there"]);
      assert.equal(events.find((event) => event.event === "message_delta").data.delta.stop_reason, "end_turn");
      assert.equal(events.at(-1).event, "message_stop");
    } finally { await e2e.close(); }
  });

  test("a messages rate limit uses the Anthropic error shape", async () => {
    const e2e = await startE2E({ config: { rateLimitRpm: 1 } });
    try {
      const first = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        headers: authHeaders(),
        body: { model: "ping", max_tokens: 4, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(first.status, 200);
      const second = await httpRequest(e2e.port, {
        method: "POST",
        reqPath: "/v1/messages",
        headers: authHeaders(),
        body: { model: "ping", max_tokens: 4, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(second.status, 429);
      assert.equal(second.json.type, "error");
      assert.equal(second.json.error.type, "rate_limit_error");
      assert.ok(Number(second.headers["retry-after"]) > 0);
    } finally { await e2e.close(); }
  });
});

describe("POST /api/archive/sessions — manual add", () => {
  const ADDED = "22222222-3333-4444-8555-666666666666";

  function postSession(port, body, headers = authHeaders({ "Content-Type": "application/json" })) {
    return httpRequest(port, { method: "POST", reqPath: "/api/archive/sessions", headers, body });
  }

  test("the route requires the bridge key", async () => {
    const e2e = await startE2E();
    try {
      const res = await postSession(e2e.port, { session: ADDED }, {});
      assert.equal(res.status, 401);
      assert.equal(res.json.error.message, "Invalid bridge key");
    } finally { await e2e.close(); }
  });

  test("an invalid id, a link with no session, and a duplicate are rejected", async () => {
    const e2e = await startE2E();
    try {
      const invalid = await postSession(e2e.port, { session: "not-a-uuid" });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.error.code, "invalid_session");

      const missing = await postSession(e2e.port, { session: "https://arena.ai/c/nope" });
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error.code, "not_found");

      const duplicate = await postSession(e2e.port, { sessionId: SESSION_ID.toUpperCase() });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.json.error.code, "already_present");

      const junk = await postSession(e2e.port, "{");
      assert.equal(junk.status, 400);
      assert.equal(junk.json.error.code, "invalid_session");
    } finally { await e2e.close(); }
  });

  test("a pasted agent URL is stored like a harvested session and shows up in the lists", async () => {
    const e2e = await startE2E({
      bridge: {
        credentials: {
          list: () => [
            { email: "off@example.com", disabled: true },
            { email: "owner@example.com", disabled: false },
          ],
          primary: () => ({ email: "owner@example.com" }),
          forSession: (email) => ({ email: email || "owner@example.com" }),
        },
      },
    });
    try {
      const res = await postSession(e2e.port, {
        session: `https://www.arena.ai/agent/${ADDED}?ref=1`,
        label: "gpt-5",
        note: "手抄",
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.sessionId, ADDED);
      assert.equal(res.json.model, "gpt-5");
      assert.equal(res.json.url, `https://arena.ai/agent/${ADDED}`);

      const listed = await httpRequest(e2e.port, { reqPath: "/api/sessions" });
      assert.equal(listed.status, 200);
      const added = listed.json.sessions.find((session) => session.sessionId === ADDED);
      assert.ok(added, "the new session must appear next to harvested ones");
      assert.equal(added.model, "gpt-5");
      assert.equal(added.prompt, "手抄");
      assert.equal(added.email, "owner@example.com");
      assert.ok(listed.json.sessions.some((session) => session.sessionId === SESSION_ID));
      assert.ok(listed.json.groups.some((group) => group.model === "gpt-5" && group.sessions.some((session) => session.sessionId === ADDED)));

      const models = await httpRequest(e2e.port, { reqPath: "/v1/models", headers: authHeaders() });
      const model = models.json.data.find((entry) => entry.id === ADDED);
      assert.ok(model);
      assert.equal(model.name, "gpt-5");
      assert.equal(model.owned_by, "arena-session");

      const stored = JSON.parse(readFileSync(path.join(e2e.config.archiveDir, "记录.json"), "utf8"));
      const row = stored.find((entry) => String(entry.Url).includes(ADDED));
      assert.equal(row.Source, "arena-bridge");
      assert.equal(row.Prompt, "手抄");
      assert.equal(row.Email, "owner@example.com");
      assert.equal(row.Model, "gpt-5");
    } finally { await e2e.close(); }
  });

  test("an unset archive directory is the same error harvest reports", async () => {
    const e2e = await startE2E({ config: { archiveDir: "" } });
    try {
      const res = await postSession(e2e.port, { session: ADDED });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, "archive_unconfigured");
      assert.match(res.json.error.message, /ARENA_ARCHIVE_DIR/);
    } finally { await e2e.close(); }
  });
});
