import test from "node:test";
import assert from "node:assert/strict";

import { createZeroCopyPassthroughStream } from "./zeroCopyStream.js";
import { FORMATS } from "../translator/formats.js";

const ARGS = '{"mode": "list", "message": ""}';

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** The event sequence Codex gpt-6-luna sent for parallel tool calls: no argument deltas. */
function lunaToolCallStream(names) {
  let seq = 0;
  let out = sse("response.created", { sequence_number: seq++, response: { id: "resp_1", status: "in_progress" } });
  names.forEach((name, index) => {
    const item = { id: `fc_${index}`, type: "function_call", call_id: `call_${index}`, name };
    out += sse("response.output_item.added", { sequence_number: seq++, output_index: index, item: { ...item, arguments: "" } });
    out += sse("response.function_call_arguments.done", { sequence_number: seq++, item_id: item.id, output_index: index, arguments: ARGS });
    out += sse("response.output_item.done", { sequence_number: seq++, output_index: index, item: { ...item, arguments: ARGS } });
  });
  return out + sse("response.completed", { sequence_number: seq++, response: { id: "resp_1", status: "completed" } });
}

async function passThrough(text, { chunkSize, sourceFormat = FORMATS.OPENAI_RESPONSES, targetFormat = FORMATS.OPENAI_RESPONSES }) {
  const bytes = new TextEncoder().encode(text);
  const stream = createZeroCopyPassthroughStream({ sourceFormat, targetFormat });
  const writer = stream.writable.getWriter();
  const reading = new Response(stream.readable).text();
  for (let i = 0; i < bytes.length; i += chunkSize) {
    await writer.write(bytes.slice(i, i + chunkSize));
  }
  await writer.close();
  return reading;
}

function events(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\n").find((l) => l.startsWith("data:")).slice(5)));
}

/** Tool arguments as a delta-driven client (LangChain) assembles them: added + deltas. */
function argumentsFromDeltas(text) {
  const byItem = {};
  for (const e of events(text)) {
    if (e.type === "response.output_item.added" && e.item.type === "function_call") byItem[e.item.id] = e.item.arguments;
    if (e.type === "response.function_call_arguments.delta") byItem[e.item_id] += e.delta;
  }
  return byItem;
}

test("parallel tool calls without argument deltas reach the client with their arguments", async () => {
  // 7-byte chunks split every event marker across network chunks.
  const output = await passThrough(lunaToolCallStream(["session_files", "workspace_files", "design_library"]), { chunkSize: 7 });

  assert.deepEqual(argumentsFromDeltas(output), { fc_0: ARGS, fc_1: ARGS, fc_2: ARGS });
  const types = events(output).map((e) => e.type);
  assert.deepEqual(types.slice(1, 5), [
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
  ]);
});

test("a stream that already sends argument deltas passes through byte for byte", async () => {
  const input =
    sse("response.output_item.added", { sequence_number: 1, output_index: 0, item: { id: "fc_0", type: "function_call", call_id: "call_0", name: "lookup", arguments: "" } }) +
    sse("response.function_call_arguments.delta", { sequence_number: 2, item_id: "fc_0", output_index: 0, delta: '{"mode": ' }) +
    sse("response.function_call_arguments.delta", { sequence_number: 3, item_id: "fc_0", output_index: 0, delta: '"list"}' }) +
    sse("response.function_call_arguments.done", { sequence_number: 4, item_id: "fc_0", output_index: 0, arguments: '{"mode": "list"}' }) +
    sse("response.completed", { sequence_number: 5, response: { status: "completed" } });

  assert.equal(await passThrough(input, { chunkSize: 11 }), input);
});

test("a chat completions passthrough is forwarded unchanged", async () => {
  const input = `data: ${JSON.stringify({ choices: [{ delta: { content: "response.function_call_arguments.done" } }] })}\n\ndata: [DONE]\n\n`;

  assert.equal(await passThrough(input, { chunkSize: 5, sourceFormat: FORMATS.OPENAI, targetFormat: FORMATS.OPENAI }), input);
});
