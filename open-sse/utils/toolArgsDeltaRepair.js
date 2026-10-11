/**
 * Restores the streamed tool-argument event some Responses upstreams leave out.
 *
 * The OpenAI Responses stream opens a function call with empty `arguments`, streams them
 * as `response.function_call_arguments.delta` events, then repeats the full text in
 * `response.function_call_arguments.done`. Some upstreams (Codex gpt-6-luna) skip the delta
 * events entirely. Clients that build tool calls from deltas — LangChain among them — then
 * run the tool with empty arguments. When a `done` event arrives for a call that had no
 * delta, this inserts one delta carrying the full arguments directly before it.
 *
 * Bytes pass through untouched except for blocks holding a function-call-arguments event;
 * only those are decoded. An incomplete trailing event is held until its end arrives, so a
 * marker split across network chunks is still seen whole.
 */

const ARGS_DELTA_TYPE = "response.function_call_arguments.delta";
const ARGS_DONE_TYPE = "response.function_call_arguments.done";
const ARGS_EVENT_MARKER = Buffer.from("response.function_call_arguments.");
const LF_BOUNDARY = Buffer.from("\n\n");
const CRLF_BOUNDARY = Buffer.from("\r\n\r\n");
const EVENT_SPLIT = /(\r?\n\r?\n)/;

const encoder = new TextEncoder();

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength || 0);
}

/** Index just past the last complete event in `buf`, or 0 when none is complete. */
function completeEventsEnd(buf) {
  const lf = buf.lastIndexOf(LF_BOUNDARY);
  const crlf = buf.lastIndexOf(CRLF_BOUNDARY);
  return Math.max(
    lf === -1 ? 0 : lf + LF_BOUNDARY.length,
    crlf === -1 ? 0 : crlf + CRLF_BOUNDARY.length,
  );
}

function parseEventData(eventText) {
  const dataLine = eventText.split(/\r?\n/).find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim());
  } catch {
    return null;
  }
}

function callKey(data) {
  return data.item_id ?? `output_index:${data.output_index}`;
}

function formatArgsDeltaEvent(doneData) {
  // No sequence_number: the upstream already numbered its events and none is free here.
  const delta = {
    type: ARGS_DELTA_TYPE,
    item_id: doneData.item_id,
    output_index: doneData.output_index,
    delta: doneData.arguments,
  };
  return `event: ${ARGS_DELTA_TYPE}\ndata: ${JSON.stringify(delta)}\n\n`;
}

export function createToolArgsDeltaRepair() {
  const callsWithDeltas = new Set();
  let pending = Buffer.alloc(0);

  function repairBlock(block) {
    const parts = block.toString("utf8").split(EVENT_SPLIT);
    let repaired = "";
    for (let i = 0; i < parts.length; i += 2) {
      const eventText = parts[i];
      const separator = parts[i + 1] ?? "";
      const data = eventText.includes(ARGS_DONE_TYPE) || eventText.includes(ARGS_DELTA_TYPE)
        ? parseEventData(eventText)
        : null;
      if (data?.type === ARGS_DELTA_TYPE) {
        callsWithDeltas.add(callKey(data));
      } else if (
        data?.type === ARGS_DONE_TYPE &&
        data.arguments &&
        !callsWithDeltas.has(callKey(data))
      ) {
        repaired += formatArgsDeltaEvent(data);
      }
      repaired += eventText + separator;
    }
    return encoder.encode(repaired);
  }

  function forward(block) {
    if (block.length === 0) return [];
    return [block.includes(ARGS_EVENT_MARKER) ? repairBlock(block) : block];
  }

  return {
    /** Returns the bytes ready to send now; an incomplete trailing event is kept back. */
    push(chunk) {
      const buf = pending.length ? Buffer.concat([pending, toBuffer(chunk)]) : toBuffer(chunk);
      const end = completeEventsEnd(buf);
      pending = buf.subarray(end);
      return forward(buf.subarray(0, end));
    },
    /** Returns whatever is still held when the upstream closes. */
    flush() {
      const rest = pending;
      pending = Buffer.alloc(0);
      return forward(rest);
    },
  };
}
