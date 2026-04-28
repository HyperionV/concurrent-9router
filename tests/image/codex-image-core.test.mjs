import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalFetch = globalThis.fetch;

function makeCodexStream(resultB64 = "aW1hZ2U=") {
  return [
    "event: response.image_generation_call.partial_image",
    'data: {"partial_image_b64":"cGFydGlhbA==","partial_image_index":0}',
    "",
    "event: response.output_item.done",
    `data: {"item":{"type":"image_generation_call","result":"${resultB64}"}}`,
    "",
  ].join("\n");
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-image-"));
}

test("codex image request strips image suffix and forwards image tool params", async () => {
  const fetchCalls = [];
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    return new Response(makeCodexStream(), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const { handleImageGenerationCore } =
    await import("open-sse/handlers/imageGenerationCore.js");

  const result = await handleImageGenerationCore({
    body: {
      prompt: "draw a router",
      image: "iVBORw0KGgo=",
      image_detail: "original",
      output_format: "webp",
      size: "1024x1536",
      quality: "high",
      background: "transparent",
    },
    modelInfo: { provider: "codex", model: "gpt-5.4-image" },
    credentials: {
      accessToken: "access-token",
      idToken: "not-a-jwt",
      providerSpecificData: { chatgptAccountId: "account-1" },
    },
  });

  assert.equal(result.success, true);

  const [url, options] = fetchCalls[0];
  assert.equal(
    url,
    "https://chatgpt.com/backend-api/codex/responses",
    "Codex image generation must call the Codex Responses endpoint",
  );

  const sent = JSON.parse(options.body);
  assert.equal(sent.model, "gpt-5.4");
  assert.deepEqual(sent.tools, [
    {
      type: "image_generation",
      output_format: "webp",
      size: "1024x1536",
      quality: "high",
      background: "transparent",
    },
  ]);
  assert.equal(sent.input[0].content[1].type, "input_image");
  assert.equal(sent.input[0].content[1].detail, "original");
  assert.match(sent.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test("codex image core returns binary response using requested codec", async () => {
  globalThis.fetch = async () =>
    new Response(makeCodexStream("aGVsbG8="), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  const { handleImageGenerationCore } =
    await import("open-sse/handlers/imageGenerationCore.js");

  const result = await handleImageGenerationCore({
    body: {
      prompt: "draw a router",
      output_format: "jpeg",
    },
    modelInfo: { provider: "codex", model: "gpt-5.3-image" },
    credentials: { accessToken: "access-token" },
    binaryOutput: true,
  });

  assert.equal(result.success, true);
  assert.equal(result.response.headers.get("Content-Type"), "image/jpeg");
  assert.equal(await result.response.text(), "hello");
});

test("codex image core rejects non-codex providers", async () => {
  const { handleImageGenerationCore } =
    await import("open-sse/handlers/imageGenerationCore.js");

  const result = await handleImageGenerationCore({
    body: { prompt: "draw a router" },
    modelInfo: { provider: "openai", model: "dall-e-3" },
    credentials: { apiKey: "key" },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /does not support image generation/);
});

test("image auth accepts active router API key before codex request", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { createApiKeyRecord, createProviderConnectionRecord } =
    await import("@/lib/sqlite/store.js");

  createApiKeyRecord({
    id: "key-image",
    name: "Image Key",
    key: "sk-image-test",
    machineId: "machine-1",
    isActive: true,
    createdAt: new Date().toISOString(),
  });
  createProviderConnectionRecord({
    id: "conn-codex",
    provider: "codex",
    name: "Codex Test",
    accessToken: "access-token",
    isActive: true,
    priority: 1,
    providerSpecificData: { chatgptAccountId: "account-1" },
  });

  const { extractApiKey, resolveActiveApiKeyRecord, getProviderCredentials } =
    await import("@/sse/services/auth.js");

  const request = new Request("http://localhost/api/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: "Bearer sk-image-test",
      "Content-Type": "application/json",
      "x-connection-id": "conn-codex",
    },
    body: JSON.stringify({
      model: "cx/gpt-5.4-image",
      prompt: "draw a router",
    }),
  });

  const apiKey = extractApiKey(request);
  const activeApiKeyRecord = await resolveActiveApiKeyRecord(apiKey);
  assert.equal(activeApiKeyRecord.id, "key-image");

  const credentials = await getProviderCredentials(
    "codex",
    new Set(),
    "gpt-5.4-image",
    { preferredConnectionId: "conn-codex" },
  );
  assert.equal(credentials.connectionId, "conn-codex");

  globalThis.fetch = async () =>
    new Response(makeCodexStream("aGVsbG8="), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  const { handleImageGenerationCore } =
    await import("open-sse/handlers/imageGenerationCore.js");
  const response = await handleImageGenerationCore({
    body: {
      model: "cx/gpt-5.4-image",
      prompt: "draw a router",
    },
    modelInfo: { provider: "codex", model: "gpt-5.4-image" },
    credentials,
  });

  assert.equal(response.success, true);
  const json = await response.response.json();
  assert.equal(json.data[0].b64_json, "aGVsbG8=");

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("codex image edits accept multipart image uploads", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { createProviderConnectionRecord } =
    await import("@/lib/sqlite/store.js");
  createProviderConnectionRecord({
    id: "conn-codex-edit",
    provider: "codex",
    name: "Codex Edit Test",
    accessToken: "access-token",
    isActive: true,
    priority: 1,
    providerSpecificData: { chatgptAccountId: "account-1" },
  });

  const fetchCalls = [];
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    return new Response(makeCodexStream("ZWRpdGVk"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const form = new FormData();
  form.set("model", "cx/gpt-5.4-image");
  form.set("prompt", "turn these into a gift basket");
  form.append(
    "image[]",
    new File([Buffer.from("image-one")], "body-lotion.png", {
      type: "image/png",
    }),
  );
  form.append(
    "image[]",
    new File([Buffer.from("image-two")], "soap.jpeg", {
      type: "image/jpeg",
    }),
  );
  form.set("output_format", "webp");
  form.set("size", "1024x1024");

  const request = new Request("http://localhost/v1/images/edits", {
    method: "POST",
    body: form,
  });

  const { handleImageEdit } = await import("@/sse/handlers/imageGeneration.js");
  const response = await handleImageEdit(request);

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.data[0].b64_json, "ZWRpdGVk");

  const sent = JSON.parse(fetchCalls[0][1].body);
  assert.equal(sent.model, "gpt-5.4");
  assert.equal(sent.tools[0].output_format, "webp");
  const imageBlocks = sent.input[0].content.filter(
    (item) => item.type === "input_image",
  );
  assert.equal(imageBlocks.length, 2);
  assert.match(imageBlocks[0].image_url, /^data:image\/png;base64,/);
  assert.match(imageBlocks[1].image_url, /^data:image\/jpeg;base64,/);

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
