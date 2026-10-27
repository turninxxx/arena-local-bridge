// wire.mjs — HTTP shape translation for clients that do not speak Chat Completions.
//
// Codex (OpenAI Responses) and Claude Code (Anthropic Messages) both become one
// chat-completion body, then the existing Arena driver runs unchanged. Replies
// are mapped back into the caller's JSON object or SSE events.
//
// Conversation state is the request itself: each call carries the transcript the
// client wants Arena to see. `previous_response_id` is a best-effort in-process
// chain (see continueFromPrevious); it is not a durable store. Codex with
// store disabled replays full `input` every turn, which is the path this
// adapter is built around. Tool loops work because function_call /
// function_call_output and tool_use / tool_result become chat tool messages
// the bridge already knows how to prompt.
import crypto from "node:crypto";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ADVERTISED_ENDPOINTS = [
  "GET /health",
  "GET /ready",
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/responses",
  "POST /v1/messages",
  "GET /",
];

export const ENDPOINT_HINT =
  "Valid endpoints: POST /v1/chat/completions (chat), POST /v1/responses (OpenAI Responses / Codex), " +
  "POST /v1/messages (Anthropic Messages / Claude Code), GET /v1/models (models), GET / (GUI), GET /health. " +
  "Codex: base_url http://127.0.0.1:20140/v1 and wire_api=responses. " +
  "Claude Code: ANTHROPIC_BASE_URL http://127.0.0.1:20140 with no /v1 suffix. " +
  "Do not append /v1 again when the base URL already ends in /v1. Chat, responses, and messages all use POST.";

const COMPLETION_ROUTES = new Map([
  ["/v1/chat/completions", "chat"],
  ["/chat/completions", "chat"],
  ["/v1/responses", "responses"],
  ["/responses", "responses"],
  ["/v1/messages", "messages"],
  ["/messages", "messages"],
]);

export function matchCompletionRoute(method, pathname) {
  if (method !== "POST") return null;
  return COMPLETION_ROUTES.get(pathname) || null;
}

/**
 * Model ids Codex and Claude send (`gpt-5.4`, `claude-sonnet-4-5`) are not
 * Arena sessions. On these wires they mean "the session picked in the GUI".
 * Chat completions does not use this helper, so its legacy runAgent path stays
 * exactly as it was. UUIDs, `active`, `ping`, and `health` pass through.
 */
export function arenaModel(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value || value === "active") return "active";
  if (value === "ping" || value === "health") return value;
  if (SESSION_ID_RE.test(value)) return value;
  return "active";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function partToText(part) {
  if (typeof part === "string") return part;
  if (!isObject(part)) return "";
  const type = String(part.type || "");
  if (type === "input_image" || type === "image" || type === "image_url") return "[image omitted]";
  if (typeof part.text === "string") return part.text;
  if (typeof part.refusal === "string") return part.refusal;
  return "";
}

export function contentParts(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join("\n");
  if (isObject(content)) return partToText(content);
  return content == null ? "" : String(content);
}

function outputToText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => partToText(part) || (isObject(part) ? contentParts(part.content) : "")).filter(Boolean).join("\n");
  if (isObject(output)) {
    if (typeof output.text === "string") return output.text;
    if (output.content !== undefined) return outputToText(output.content);
    return JSON.stringify(output);
  }
  return output == null ? "" : String(output);
}

function appendToolCall(messages, call) {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    if (!Array.isArray(last.tool_calls)) last.tool_calls = [];
    if (!last.content) last.content = null;
    last.tool_calls.push(call);
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [call] });
}

function pushTextMessage(messages, role, content) {
  const text = typeof content === "string" ? content : contentParts(content);
  if (!text) return;
  messages.push({ role, content: text });
}

function chatTool(name, description, parameters) {
  return {
    type: "function",
    function: {
      name,
      description: typeof description === "string" ? description : "",
      parameters: isObject(parameters) ? parameters : { type: "object", properties: {} },
    },
  };
}

function responsesToolsToChat(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return { error: "tools must be an array" };
  const out = [];
  const visit = (tool) => {
    if (!isObject(tool)) return;
    if (Array.isArray(tool.tools)) {
      for (const nested of tool.tools) visit(nested);
      return;
    }
    if (isObject(tool.function) && typeof tool.function.name === "string") {
      out.push(chatTool(tool.function.name, tool.function.description, tool.function.parameters));
      return;
    }
    const type = String(tool.type || "function");
    if (type !== "function" && type !== "custom") return;
    if (typeof tool.name !== "string" || !tool.name) return;
    out.push(chatTool(tool.name, tool.description, tool.parameters || tool.input_schema));
  };
  for (const tool of tools) visit(tool);
  return out;
}

function mapResponsesToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (!isObject(choice)) return undefined;
  if (isObject(choice.function) && typeof choice.function.name === "string") return choice;
  if (typeof choice.name === "string" && (choice.type === "function" || choice.type === "custom")) {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

function consumeResponseItem(messages, raw) {
  if (typeof raw === "string") {
    if (raw) messages.push({ role: "user", content: raw });
    return;
  }
  if (!isObject(raw)) return;
  const type = typeof raw.type === "string" ? raw.type : "";
  if (type === "function_call" || type === "custom_tool_call") {
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!name) return;
    const rawArgs = raw.arguments ?? raw.input ?? {};
    appendToolCall(messages, {
      id: String(raw.call_id || raw.id || `call_${messages.length}`),
      type: "function",
      function: { name, arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs) },
    });
    return;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    messages.push({
      role: "tool",
      tool_call_id: String(raw.call_id || raw.id || ""),
      content: outputToText(raw.output ?? raw.content ?? ""),
    });
    return;
  }
  if (type === "reasoning" || type === "item_reference" || type === "compaction_summary") return;
  const role = String(raw.role || "");
  if (!role) return;
  if (role === "tool") {
    messages.push({
      role: "tool",
      tool_call_id: String(raw.tool_call_id || raw.call_id || ""),
      content: contentParts(raw.content),
    });
    return;
  }
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") return;
  if (role === "assistant") {
    const text = contentParts(raw.content);
    if (text) messages.push({ role: "assistant", content: text });
    return;
  }
  pushTextMessage(messages, role, raw.content);
}

/**
 * Responses request → chat-completion body.
 * `previous_response_id` is ignored here; the server stitches it on when it
 * still has that response in memory.
 */
export function responsesToChat(body) {
  if (!isObject(body)) return { error: "request body must be a JSON object" };
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) consumeResponseItem(messages, item);
  } else if (input != null) {
    return { error: "input must be a string or an array of items" };
  }
  if (!messages.length) return { error: "input must contain at least one message" };
  const tools = responsesToolsToChat(body.tools);
  if (tools && tools.error) return { error: tools.error };
  const chat = {
    model: arenaModel(body.model),
    messages,
    stream: body.stream === true,
  };
  if (Array.isArray(tools)) chat.tools = tools;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  const maxTokens = typeof body.max_output_tokens === "number" ? body.max_output_tokens : body.max_tokens;
  if (typeof maxTokens === "number") chat.max_tokens = maxTokens;
  if (isObject(body.metadata)) chat.metadata = body.metadata;
  const toolChoice = mapResponsesToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  return { chat };
}

function flattenSystem(system) {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  return system.map((block) => (typeof block === "string" ? block : partToText(block))).filter(Boolean).join("\n\n").trim();
}

function splitUser(content) {
  if (typeof content === "string") return { textParts: content ? [content] : [], toolResults: [] };
  if (!Array.isArray(content)) {
    const text = contentParts(content);
    return { textParts: text ? [text] : [], toolResults: [] };
  }
  const textParts = [];
  const toolResults = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) textParts.push(part);
      continue;
    }
    if (!isObject(part)) continue;
    if (part.type === "tool_result") {
      toolResults.push({
        id: String(part.tool_use_id || part.id || ""),
        content: outputToText(part.content ?? ""),
      });
      continue;
    }
    if (part.type === "thinking" || part.type === "redacted_thinking" || part.type === "tool_reference") continue;
    const text = partToText(part);
    if (text) textParts.push(text);
  }
  return { textParts, toolResults };
}

function splitAssistant(content) {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  if (!Array.isArray(content)) return { text: contentParts(content), toolCalls: [] };
  const textParts = [];
  const toolCalls = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === "tool_use") {
      const name = typeof part.name === "string" ? part.name : "";
      if (!name) continue;
      const input = part.input ?? {};
      toolCalls.push({
        id: String(part.id || `toolu_${toolCalls.length}`),
        type: "function",
        function: { name, arguments: typeof input === "string" ? input : JSON.stringify(input) },
      });
      continue;
    }
    if (part.type === "thinking" || part.type === "redacted_thinking") continue;
    const text = partToText(part);
    if (text) textParts.push(text);
  }
  return { text: textParts.join("\n"), toolCalls };
}

function anthropicToolsToChat(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return { error: "tools must be an array" };
  const out = [];
  for (const raw of tools) {
    if (!isObject(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type && type !== "function" && type !== "custom") continue;
    const name = typeof raw.name === "string" ? raw.name : isObject(raw.function) ? raw.function.name : "";
    if (typeof name !== "string" || !name) continue;
    const description = raw.description ?? raw.function?.description;
    const parameters = raw.input_schema ?? raw.parameters ?? raw.function?.parameters;
    out.push(chatTool(name, description, parameters));
  }
  return out;
}

function mapAnthropicToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (!isObject(choice)) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

/** Anthropic Messages request → chat-completion body. */
export function anthropicToChat(body) {
  if (!isObject(body)) return { error: "request body must be a JSON object" };
  if (!Array.isArray(body.messages)) return { error: "messages must be a non-empty array" };
  const messages = [];
  const system = flattenSystem(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const raw of body.messages) {
    if (!isObject(raw)) return { error: "each message must be an object" };
    const role = String(raw.role || "");
    if (role === "system" || role === "developer") {
      pushTextMessage(messages, "system", raw.content);
      continue;
    }
    if (role === "assistant") {
      const { text, toolCalls } = splitAssistant(raw.content);
      if (!text && !toolCalls.length) continue;
      const assistant = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }
    if (role === "user") {
      const { textParts, toolResults } = splitUser(raw.content);
      for (const result of toolResults) {
        messages.push({ role: "tool", tool_call_id: result.id, content: result.content });
      }
      if (textParts.length) messages.push({ role: "user", content: textParts.join("\n") });
      continue;
    }
    return { error: `unsupported role: ${role}` };
  }
  if (!messages.length) return { error: "messages must be a non-empty array" };
  const tools = anthropicToolsToChat(body.tools);
  if (tools && tools.error) return { error: tools.error };
  const chat = {
    model: arenaModel(body.model),
    messages,
    stream: body.stream === true,
  };
  if (Array.isArray(tools)) chat.tools = tools;
  if (typeof body.max_tokens === "number") chat.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (isObject(body.metadata)) chat.metadata = body.metadata;
  const toolChoice = mapAnthropicToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  return { chat };
}

/**
 * When the client resends the original user turn, it is already a full replay
 * and must be used as-is. Otherwise `incoming` is only the new tail (typically
 * a tool result) and is appended to the transcript stored for `previous_response_id`.
 * Repeated top-level instructions are dropped on that tail so the system prompt
 * is not stacked twice.
 */
export function continueFromPrevious(storedMessages, incomingMessages) {
  const stored = Array.isArray(storedMessages) ? storedMessages : [];
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  if (!stored.length) return incoming;
  const firstUser = stored.find((message) => message?.role === "user" && typeof message.content === "string" && message.content);
  if (firstUser && incoming.some((message) => message?.role === "user" && message.content === firstUser.content)) {
    return incoming;
  }
  const extra = incoming.filter((message) => message?.role !== "system" && message?.role !== "developer");
  return [...stored, ...extra];
}

export function assistantTranscriptMessage(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const assistant = { role: "assistant", content: null };
  if (typeof message.content === "string" && message.content) assistant.content = message.content;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) assistant.tool_calls = message.tool_calls;
  if (!assistant.tool_calls && assistant.content == null) assistant.content = "";
  return assistant;
}

function usageOf(payload) {
  const usage = payload?.usage || {};
  const input = Number(usage.prompt_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  return {
    input,
    output,
    total: Number(usage.total_tokens) || input + output,
  };
}

function parseToolInput(value) {
  if (isObject(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed)) return parsed;
    } catch {
      /* arguments were not JSON */
    }
    return { raw: value };
  }
  return {};
}

/** Chat completion → Responses object. */
export function chatToResponse(payload, { id, model, created } = {}) {
  const message = payload?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  const responseId = id || `resp_${crypto.randomBytes(12).toString("hex")}`;
  const output = [];
  if (text || !toolCalls.length) {
    output.push({
      id: `msg_${responseId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    const fn = isObject(call?.function) ? call.function : {};
    const callId = String(call?.id || `call_${output.length}`);
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    output.push({
      id: callId,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: String(fn.name || ""),
      arguments: args,
    });
  }
  if (reasoning) {
    output.push({
      id: `rs_${responseId}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
      content: [{ type: "reasoning_text", text: reasoning }],
    });
  }
  const usage = usageOf(payload);
  return {
    id: responseId,
    object: "response",
    created_at: created || payload?.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: model || payload?.model || "active",
    output,
    error: null,
    incomplete_details: null,
    store: false,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/** Chat completion → Anthropic message. Thinking blocks are omitted: Claude Code requires a signature we do not have. */
export function chatToAnthropic(payload, { id, model } = {}) {
  const message = payload?.choices?.[0]?.message || {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = [];
  if (text || !toolCalls.length) content.push({ type: "text", text });
  for (const call of toolCalls) {
    const fn = isObject(call?.function) ? call.function : {};
    content.push({
      type: "tool_use",
      id: String(call?.id || `toolu_${content.length}`),
      name: String(fn.name || ""),
      input: parseToolInput(fn.arguments),
    });
  }
  const usage = usageOf(payload);
  const finish = payload?.choices?.[0]?.finish_reason;
  return {
    id: id || `msg_${crypto.randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: model || payload?.model || "active",
    content,
    stop_reason: toolCalls.length ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
}

export function anthropicErrorBody(error, requestId) {
  const status = Number(error?.status || 500);
  const type = status === 400 || status === 409 || status === 422
    ? "invalid_request_error"
    : status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 413
            ? "request_too_large"
            : status === 429
              ? "rate_limit_error"
              : "api_error";
  const message = error instanceof Error ? error.message : String(error?.message || error || "request failed");
  return {
    type: "error",
    error: {
      type,
      message,
      ...(error?.code ? { code: error.code } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

function sseWrite(write, event) {
  write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Responses SSE. Text deltas use output_index 0 when a message is open.
 * `response.completed` carries the same output items those events described.
 * Function calls include both argument deltas and `output_item.done`, which
 * is the pair Codex uses to finish a tool call.
 */
export function createResponseStream(write, { id, model, created }) {
  const responseId = id;
  const createdAt = created || Math.floor(Date.now() / 1000);
  let streamed = "";
  let messageOpened = false;
  const messageId = `msg_${responseId}`;

  const shell = (status) => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    model: model || "active",
    output: [],
    error: null,
  });

  const openMessage = () => {
    if (messageOpened) return;
    messageOpened = true;
    sseWrite(write, {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: messageId, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    sseWrite(write, {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  const emitTextDelta = (chunk) => {
    if (!chunk) return;
    openMessage();
    streamed += chunk;
    sseWrite(write, {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: chunk,
    });
  };

  sseWrite(write, { type: "response.created", response: shell("in_progress") });
  sseWrite(write, { type: "response.in_progress", response: shell("in_progress") });

  return {
    delta: emitTextDelta,
    complete(payload) {
      const message = payload?.choices?.[0]?.message || {};
      const finalText = typeof message.content === "string" ? message.content : "";
      if (!streamed || finalText.startsWith(streamed)) emitTextDelta(finalText.slice(streamed.length));
      const built = chatToResponse(payload, { id: responseId, model, created: createdAt });
      if (messageOpened && !built.output.some((item) => item.type === "message")) {
        built.output.unshift({
          id: messageId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: streamed, annotations: [] }],
        });
      }
      let closedMessage = false;
      for (let index = 0; index < built.output.length; index += 1) {
        const item = built.output[index];
        if (item.type === "message") {
          closedMessage = true;
          if (!messageOpened) openMessage();
          const text = item.content?.[0]?.text || "";
          sseWrite(write, {
            type: "response.output_text.done",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text,
          });
          sseWrite(write, {
            type: "response.content_part.done",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text, annotations: [] },
          });
          sseWrite(write, { type: "response.output_item.done", output_index: 0, item: { ...item, id: messageId } });
          continue;
        }
        if (item.type === "function_call") {
          sseWrite(write, {
            type: "response.output_item.added",
            output_index: index,
            item: { ...item, status: "in_progress", arguments: "" },
          });
          if (item.arguments) {
            sseWrite(write, {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: index,
              delta: item.arguments,
            });
          }
          sseWrite(write, {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: index,
            arguments: item.arguments,
          });
          sseWrite(write, { type: "response.output_item.done", output_index: index, item });
          continue;
        }
        if (item.type === "reasoning") {
          const summary = item.summary?.[0]?.text || "";
          sseWrite(write, {
            type: "response.output_item.added",
            output_index: index,
            item: { id: item.id, type: "reasoning", status: "in_progress", summary: [], content: [] },
          });
          if (summary) {
            sseWrite(write, {
              type: "response.reasoning_summary_text.delta",
              item_id: item.id,
              output_index: index,
              delta: summary,
            });
          }
          sseWrite(write, { type: "response.output_item.done", output_index: index, item });
        }
      }
      if (messageOpened && !closedMessage) {
        sseWrite(write, {
          type: "response.output_text.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: streamed,
        });
        sseWrite(write, {
          type: "response.content_part.done",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: streamed, annotations: [] },
        });
        sseWrite(write, {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: streamed, annotations: [] }],
          },
        });
      }
      sseWrite(write, { type: "response.completed", response: built });
    },
    fail(error) {
      const message = error instanceof Error ? error.message : String(error?.message || error || "request failed");
      sseWrite(write, {
        type: "response.failed",
        message,
        response: {
          ...shell("failed"),
          error: {
            type: "arena_agent_error",
            code: error?.code || "arena_agent_error",
            message,
          },
        },
      });
    },
  };
}

/** Anthropic SSE: message_start, content blocks, message_delta, message_stop. */
export function createAnthropicStream(write, { id, model }) {
  let started = false;
  let textOpen = false;
  let textIndex = -1;
  let nextIndex = 0;
  let streamed = "";

  const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

  const begin = () => {
    if (started) return;
    started = true;
    send("message_start", {
      message: {
        id,
        type: "message",
        role: "assistant",
        model: model || "active",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const openText = () => {
    if (textOpen) return;
    begin();
    textOpen = true;
    textIndex = nextIndex;
    nextIndex += 1;
    send("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } });
  };

  return {
    start() {
      if (started) return;
      begin();
      send("ping", {});
    },
    ping() {
      if (!started) return;
      send("ping", {});
    },
    delta(chunk) {
      if (!chunk) return;
      openText();
      streamed += chunk;
      send("content_block_delta", { index: textIndex, delta: { type: "text_delta", text: chunk } });
    },
    complete(payload) {
      begin();
      const final = chatToAnthropic(payload, { id, model });
      const textBlock = final.content.find((block) => block.type === "text");
      const tools = final.content.filter((block) => block.type === "tool_use");
      const finalText = textBlock?.text || "";
      if (!streamed || finalText.startsWith(streamed)) {
        const rest = finalText.slice(streamed.length);
        if (rest) this.delta(rest);
      }
      if (textOpen) {
        send("content_block_stop", { index: textIndex });
      } else if (!tools.length) {
        openText();
        send("content_block_stop", { index: textIndex });
      }
      for (const tool of tools) {
        const index = nextIndex;
        nextIndex += 1;
        const partial = JSON.stringify(tool.input ?? {});
        send("content_block_start", {
          index,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        });
        send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: partial } });
        send("content_block_stop", { index });
      }
      send("message_delta", {
        delta: { stop_reason: final.stop_reason, stop_sequence: null },
        usage: { output_tokens: final.usage.output_tokens || 0 },
      });
      send("message_stop", {});
    },
    fail(error) {
      begin();
      const message = error instanceof Error ? error.message : String(error?.message || error || "request failed");
      send("error", { error: { type: "api_error", message } });
    },
  };
}
