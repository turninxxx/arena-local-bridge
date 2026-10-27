import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessages, requestedTools } from "../src/format.mjs";
import {
  anthropicErrorBody,
  anthropicToChat,
  arenaModel,
  assistantTranscriptMessage,
  chatToAnthropic,
  chatToResponse,
  continueFromPrevious,
  createAnthropicStream,
  createResponseStream,
  responsesToChat,
} from "../src/wire.mjs";

const SESSION = "11111111-2222-4333-8444-555555555555";

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
    const payload = JSON.parse(data.join("\n"));
    events.push({ event: eventName || payload.type, data: payload });
  }
  return events;
}

test("arenaModel keeps session ids and folds client model names to active", () => {
  assert.equal(arenaModel("gpt-5.4"), "active");
  assert.equal(arenaModel("claude-sonnet-4-5"), "active");
  assert.equal(arenaModel(""), "active");
  assert.equal(arenaModel("active"), "active");
  assert.equal(arenaModel("ping"), "ping");
  assert.equal(arenaModel(SESSION), SESSION);
});

test("responsesToChat maps instructions, messages, tool calls, and flat tools", () => {
  const { chat, error } = responsesToChat({
    model: "gpt-5.4",
    instructions: "be brief",
    previous_response_id: "resp_ignored_here",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call", call_id: "call_1", name: "Bash", arguments: "{\"command\":\"ls\"}" },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
    ],
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "Bash",
        description: "run",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
    max_output_tokens: 32,
    stream: true,
  });
  assert.equal(error, undefined);
  assert.equal(chat.model, "active");
  assert.equal(chat.stream, true);
  assert.equal(chat.max_tokens, 32);
  assert.deepEqual(chat.messages.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(chat.messages[0].content, "be brief");
  assert.equal(chat.messages[1].content, "list files");
  assert.equal(chat.messages[2].tool_calls[0].id, "call_1");
  assert.equal(chat.messages[2].tool_calls[0].function.name, "Bash");
  assert.equal(chat.messages[3].content, "a.txt");
  assert.equal(chat.tools[0].function.name, "Bash");
  assert.equal(requestedTools(chat.tools)[0].name, "Bash");
  const prompt = formatMessages(chat.messages, true, chat.tools, { enabled: false });
  assert.match(prompt, /Bash/);
  assert.match(prompt, /a\.txt/);
  assert.match(prompt, /CURRENT TURN/);
});

test("responsesToChat accepts a string input and rejects an empty body", () => {
  const ok = responsesToChat({ model: SESSION, input: "Hello" });
  assert.equal(ok.chat.model, SESSION);
  assert.equal(ok.chat.messages[0].content, "Hello");
  assert.equal(responsesToChat({}).error, "input must contain at least one message");
  assert.equal(responsesToChat({ tools: "nope", input: "hi" }).error, "tools must be an array");
});

test("continueFromPrevious appends a tool tail and keeps a full replay intact", () => {
  const stored = [
    { role: "system", content: "be brief" },
    { role: "user", content: "list files" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
  ];
  const tail = continueFromPrevious(stored, [
    { role: "system", content: "be brief" },
    { role: "tool", tool_call_id: "call_1", content: "a.txt" },
  ]);
  assert.deepEqual(tail.map((message) => message.role), ["system", "user", "assistant", "tool"]);
  assert.equal(tail.at(-1).content, "a.txt");
  const replay = [
    { role: "system", content: "be brief" },
    { role: "user", content: "list files" },
    { role: "tool", tool_call_id: "call_1", content: "a.txt" },
  ];
  assert.equal(continueFromPrevious(stored, replay), replay);
});

test("chatToResponse emits message text and function_call items", () => {
  const response = chatToResponse({
    model: "active",
    created: 10,
    choices: [{
      message: {
        role: "assistant",
        content: "done",
        reasoning_content: "looked",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }, { id: "resp_test", model: "active", created: 10 });
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.store, false);
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[0].content[0].text, "done");
  assert.equal(response.output[1].type, "function_call");
  assert.equal(response.output[1].call_id, "call_1");
  assert.equal(response.output[1].name, "Bash");
  assert.equal(response.output[1].arguments, "{\"command\":\"ls\"}");
  assert.equal(response.output[2].type, "reasoning");
  assert.equal(response.usage.input_tokens, 3);
  assert.equal(response.usage.output_tokens, 2);
  assert.equal(response.usage.total_tokens, 5);
});

test("response SSE streams text deltas, tool-call arguments, and response.completed", () => {
  let raw = "";
  const stream = createResponseStream((chunk) => { raw += chunk; }, { id: "resp_sse", model: "active", created: 4 });
  stream.delta("partial ");
  stream.complete({
    choices: [{
      message: {
        role: "assistant",
        content: "partial answer",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const events = parseSse(raw);
  const types = events.map((event) => event.data.type);
  assert.ok(types.includes("response.created"));
  assert.ok(types.includes("response.output_text.delta"));
  assert.ok(types.includes("response.function_call_arguments.delta"));
  assert.ok(types.includes("response.output_item.done"));
  assert.equal(types.at(-1), "response.completed");
  const deltas = events.filter((event) => event.data.type === "response.output_text.delta").map((event) => event.data.delta);
  assert.deepEqual(deltas, ["partial ", "answer"]);
  const done = events.find((event) => event.data.type === "response.output_item.done" && event.data.item?.type === "function_call");
  assert.equal(done.data.item.call_id, "call_9");
  assert.equal(done.data.item.arguments, "{\"command\":\"pwd\"}");
  const completed = events.at(-1).data.response;
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, "resp_sse");
  assert.ok(completed.output.some((item) => item.type === "function_call"));
});

test("anthropicToChat maps system, tool_use, and tool_result into chat messages", () => {
  const { chat } = anthropicToChat({
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "list files" }, { type: "image", source: { type: "base64", data: "xx" } }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "checking" },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
    ],
    tools: [{
      name: "Bash",
      description: "run",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }, { type: "advisor_20260301", name: "advisor" }],
    stream: false,
  });
  assert.equal(chat.model, "active");
  assert.equal(chat.max_tokens, 64);
  assert.equal(chat.messages[0].content, "be brief");
  assert.match(chat.messages[1].content, /list files/);
  assert.match(chat.messages[1].content, /\[image omitted\]/);
  assert.equal(chat.messages[2].content, "checking");
  assert.equal(chat.messages[2].tool_calls[0].id, "toolu_1");
  assert.equal(chat.messages[2].tool_calls[0].function.arguments, "{\"command\":\"ls\"}");
  assert.equal(chat.messages[3].role, "tool");
  assert.equal(chat.messages[3].tool_call_id, "toolu_1");
  assert.equal(chat.messages[3].content, "a.txt");
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].function.parameters.required[0], "command");
  assert.doesNotMatch(JSON.stringify(chat.messages), /secret/);
});

test("chatToAnthropic returns tool_use blocks and tool_use stop_reason", () => {
  const message = chatToAnthropic({
    choices: [{
      message: {
        content: "checking",
        tool_calls: [{ id: "toolu_1", type: "function", function: { name: "Bash", arguments: "{\"command\":\"ls\"}" } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 4, completion_tokens: 6 },
  }, { id: "msg_test", model: SESSION });
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0].text, "checking");
  assert.equal(message.content[1].type, "tool_use");
  assert.equal(message.content[1].id, "toolu_1");
  assert.deepEqual(message.content[1].input, { command: "ls" });
  assert.equal(message.usage.output_tokens, 6);
  assert.equal(assistantTranscriptMessage({
    choices: [{ message: { content: null, tool_calls: message.content.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } })) } }],
  }).tool_calls[0].id, "toolu_1");
});

test("anthropic SSE emits text deltas, input_json_delta, and message_stop", () => {
  let raw = "";
  const stream = createAnthropicStream((chunk) => { raw += chunk; }, { id: "msg_sse", model: "active" });
  stream.start();
  stream.delta("Hi");
  stream.complete({
    choices: [{
      message: {
        content: "Hi there",
        tool_calls: [{ id: "toolu_9", type: "function", function: { name: "Bash", arguments: "{\"command\":\"pwd\"}" } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 3 },
  });
  const events = parseSse(raw);
  assert.equal(events[0].event, "message_start");
  assert.equal(events[0].data.message.id, "msg_sse");
  const text = events.filter((event) => event.data.delta?.type === "text_delta").map((event) => event.data.delta.text);
  assert.deepEqual(text, ["Hi", " there"]);
  const toolDelta = events.find((event) => event.data.delta?.type === "input_json_delta");
  assert.equal(toolDelta.data.delta.partial_json, "{\"command\":\"pwd\"}");
  const delta = events.find((event) => event.event === "message_delta");
  assert.equal(delta.data.delta.stop_reason, "tool_use");
  assert.equal(delta.data.usage.output_tokens, 3);
  assert.equal(events.at(-1).event, "message_stop");
});

test("anthropicErrorBody uses Anthropic error types", () => {
  assert.equal(anthropicErrorBody({ message: "nope", status: 400 }).error.type, "invalid_request_error");
  assert.equal(anthropicErrorBody({ message: "slow", status: 429 }).error.type, "rate_limit_error");
  const failed = anthropicErrorBody(Object.assign(new Error("gone"), { status: 503, code: "session_gone" }), "req_1");
  assert.equal(failed.type, "error");
  assert.equal(failed.error.type, "api_error");
  assert.equal(failed.error.code, "session_gone");
  assert.equal(failed.error.request_id, "req_1");
});

test("response stream failure is a response.failed event", () => {
  let raw = "";
  const stream = createResponseStream((chunk) => { raw += chunk; }, { id: "resp_fail", model: "active", created: 1 });
  stream.fail(Object.assign(new Error("session gone"), { code: "session_gone" }));
  const events = parseSse(raw);
  const failed = events.find((event) => event.data.type === "response.failed");
  assert.equal(failed.data.response.status, "failed");
  assert.equal(failed.data.response.error.code, "session_gone");
  assert.match(failed.data.message, /session gone/);
});
