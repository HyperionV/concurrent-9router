import test from "node:test";
import assert from "node:assert/strict";

import { translateRequest } from "../index.js";
import { FORMATS } from "../formats.js";

// A Chat Completions request from a LangChain/OpenAI client, as the Codex and
// Grok Responses upstreams receive it.
function toResponses(body) {
  return translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "gpt-5-codex", body, true);
}

test("the caller's reasoning effort, tool choice and parallel tool setting reach the upstream request", () => {
  const request = toResponses({
    model: "codex/gpt-5-codex",
    messages: [{ role: "user", content: "Which deals closed this week?" }],
    reasoning_effort: "high",
    parallel_tool_calls: false,
    tools: [
      {
        type: "function",
        function: { name: "search_deals", parameters: { type: "object", properties: {} } },
      },
    ],
    tool_choice: { type: "function", function: { name: "search_deals" } },
  });

  assert.equal(request.reasoning_effort, "high");
  assert.equal(request.parallel_tool_calls, false);
  assert.deepEqual(request.tool_choice, { type: "function", name: "search_deals" });
});

test("a plain tool choice such as required is passed through", () => {
  const request = toResponses({
    messages: [{ role: "user", content: "Look it up." }],
    tool_choice: "required",
  });

  assert.equal(request.tool_choice, "required");
});

test("every system and developer instruction reaches the upstream, including ones given as text parts", () => {
  const request = toResponses({
    messages: [
      { role: "system", content: "You are Brae's deal assistant." },
      { role: "developer", content: [{ type: "text", text: "Answer in British English." }] },
      { role: "user", content: "Summarise the Acme deal." },
    ],
  });

  assert.equal(
    request.instructions,
    "You are Brae's deal assistant.\n\nAnswer in British English.",
  );
  assert.deepEqual(
    request.input.map((item) => item.role),
    ["user"],
    "instructions are not repeated as conversation turns",
  );
});
