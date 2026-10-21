/**
 * A combo entry switched to `anthropic/<model>` must work for the same clients, unchanged:
 * OpenAI Responses and Chat Completions callers, and Anthropic Messages callers. The real
 * translators and executor run; nothing is sent upstream.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { translateRequest, translateResponse, initState } from "open-sse/translator/index.js";
import { getExecutor } from "open-sse/executors/index.js";

const MODEL = "claude-haiku-5-5";
const CREDENTIALS = { apiKey: "sk-ant-api03-test" };

// Shaped like a captured Brae Manager turn: instructions, a finished tool round trip with the
// Codex reasoning item still in the history, sampling and cache fields Anthropic does not accept.
function responsesRequest() {
  return {
    model: "anthropic/claude-haiku-5-5",
    stream: true,
    instructions: "You are Brae's deal assistant. Answer from the deal room only.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Summarise the CIM." }] },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAAB-openai-only" },
      { type: "function_call", call_id: "call_1", name: "search_documents", arguments: "{\"query\":\"CIM\"}" },
      { type: "function_call_output", call_id: "call_1", output: "CIM: revenue 12M, EBITDA 3M." },
    ],
    tools: [{
      type: "function",
      name: "search_documents",
      description: "Search the deal room.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }],
    tool_choice: "auto",
    reasoning: { effort: "medium", summary: "auto" },
    temperature: 0.7,
    prompt_cache_key: "8a1f0c2e-0000-0000-0000-000000000000",
    store: false,
  };
}

function toAnthropicWire(sourceFormat, body) {
  const translated = translateRequest(sourceFormat, "claude", MODEL, body, true, CREDENTIALS, "anthropic");
  const executor = getExecutor("anthropic");
  return {
    body: executor.transformRequest(MODEL, translated),
    headers: executor.buildHeaders(CREDENTIALS, true),
    url: executor.buildUrl(MODEL, true, 0, CREDENTIALS),
  };
}

function assertAcceptedByAnthropic({ body, headers, url }) {
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers["x-api-key"], CREDENTIALS.apiKey);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["anthropic-beta"], undefined);
  for (const rejected of ["prompt_cache_key", "temperature", "top_p", "top_k", "reasoning", "store", "input"]) {
    assert.equal(body[rejected], undefined, `${rejected} reaches Anthropic`);
  }
  const systemText = (body.system || []).map((block) => block.text).join("\n");
  assert.doesNotMatch(systemText, /Claude Code/);
}

test("an OpenAI Responses request reaches Anthropic in a shape it accepts", () => {
  const wire = toAnthropicWire("openai-responses", responsesRequest());

  assertAcceptedByAnthropic(wire);
  assert.equal(wire.body.model, MODEL);
  assert.deepEqual(wire.body.thinking, { type: "adaptive" });
  assert.deepEqual(wire.body.output_config, { effort: "medium" });
  assert.match(wire.body.system[0].text, /deal assistant/);
  assert.deepEqual(wire.body.tools.map((tool) => tool.name), ["search_documents"]);
  const blockTypes = wire.body.messages.flatMap((message) => message.content.map((block) => block.type));
  assert.deepEqual(blockTypes, ["text", "tool_use", "tool_result"]);
});

test("an OpenAI Chat Completions request reaches Anthropic in a shape it accepts", () => {
  const wire = toAnthropicWire("openai", {
    model: "anthropic/claude-haiku-5-5",
    stream: true,
    messages: [
      { role: "system", content: "You are Brae's deal assistant." },
      { role: "user", content: "Find the CIM." },
    ],
    tools: [{ type: "function", function: { name: "search_documents", parameters: { type: "object", properties: {} } } }],
    tool_choice: { type: "function", function: { name: "search_documents" } },
    reasoning_effort: "high",
    temperature: 0.2,
    top_p: 0.9,
  });

  assertAcceptedByAnthropic(wire);
  assert.deepEqual(wire.body.tool_choice, { type: "tool", name: "search_documents" });
  assert.deepEqual(wire.body.output_config, { effort: "high" });
});

test("an Anthropic Messages request passes through with the client's own settings", () => {
  const wire = toAnthropicWire("claude", {
    model: "anthropic/claude-haiku-5-5",
    max_tokens: 2048,
    stream: true,
    system: [{ type: "text", text: "You are Brae's deal assistant." }],
    messages: [{ role: "user", content: [{ type: "text", text: "Find the CIM." }] }],
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    temperature: 1,
  });

  assertAcceptedByAnthropic(wire);
  assert.equal(wire.body.max_tokens, 2048);
  assert.deepEqual(wire.body.output_config, { effort: "low" });
});

// Current models stream thinking with an empty display by default, then the answer and a tool call.
const CLAUDE_REPLY_EVENTS = [
  { type: "message_start", message: { id: "msg_1", model: MODEL, usage: { input_tokens: 900, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the CIM first." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCgIYAhIM" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Revenue is 12M." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "search_documents", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"query\":\"EBITDA\"}" } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 900, output_tokens: 40 } },
  { type: "message_stop" },
];

function translateReply(sourceFormat) {
  const state = { ...initState(sourceFormat), provider: "anthropic", model: MODEL };
  // Serialised per event, as the stream writes each chunk to the client before the next one.
  return CLAUDE_REPLY_EVENTS.flatMap((event) =>
    JSON.parse(JSON.stringify(translateResponse("claude", sourceFormat, event, state))));
}

test("an Anthropic reply reaches a Chat Completions client without thinking in the answer", () => {
  const deltas = translateReply("openai").map((chunk) => chunk.choices?.[0]?.delta || {});

  assert.equal(deltas.map((delta) => delta.content || "").join(""), "Revenue is 12M.");
  assert.equal(deltas.map((delta) => delta.reasoning_content || "").join(""), "Check the CIM first.");
  const toolArguments = deltas.flatMap((delta) => delta.tool_calls || []).map((call) => call.function?.arguments || "").join("");
  assert.equal(toolArguments, "{\"query\":\"EBITDA\"}");
});

test("an Anthropic reply reaches a Responses client as reasoning, then the answer, then the tool call", () => {
  const events = translateReply("openai-responses");
  const doneItems = events.filter((event) => event.event === "response.output_item.done").map((event) => event.data.item);

  assert.deepEqual(doneItems.map((item) => item.type), ["reasoning", "message", "function_call"]);
  assert.equal(doneItems[1].content[0].text, "Revenue is 12M.");
  assert.equal(doneItems[2].name, "search_documents");
  assert.equal(doneItems[2].arguments, "{\"query\":\"EBITDA\"}");
});

// LangChain's ChatOpenAI (Brae's Manager) rebuilds the reply from response.completed and fails
// with "'NoneType' object is not iterable" when response.output is missing.
test("an Anthropic reply ends with a completed Response that holds every item and the usage", () => {
  const events = translateReply("openai-responses");
  const addedIndexes = events
    .filter((event) => event.event === "response.output_item.added")
    .map((event) => event.data.output_index);
  const completed = events.find((event) => event.event === "response.completed").data.response;

  assert.deepEqual(addedIndexes, [0, 1, 2]);
  assert.deepEqual(completed.output.map((item) => item.type), ["reasoning", "message", "function_call"]);
  assert.equal(completed.usage.input_tokens, 900);
  assert.equal(completed.usage.output_tokens, 40);
  assert.equal(completed.usage.input_tokens_details.cached_tokens, 0);
  assert.equal(completed.usage.output_tokens_details.reasoning_tokens, 0);
});

test("Claude Code subscriptions keep their identity line and OpenAI keeps its cache key", () => {
  const claudeBody = translateRequest("openai-responses", "claude", MODEL, responsesRequest(), true, CREDENTIALS, "claude");
  assert.match(claudeBody.system[0].text, /Claude Code/);

  const openaiBody = getExecutor("openai").transformRequest("gpt-5.5", {
    model: "gpt-5.5",
    messages: [{ role: "system", content: "You are Brae's deal assistant." }, { role: "user", content: "Hi" }],
  });
  assert.match(openaiBody.prompt_cache_key, /^pck_/);
});
