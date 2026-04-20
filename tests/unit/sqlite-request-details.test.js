import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("sqlite request detail lookup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/sqlite/runtime.js");
    vi.resetModules();
  });

  it("queries a single request detail by id without loading the whole table", async () => {
    const prepare = vi.fn((sql) => {
      if (sql.includes("SELECT * FROM request_details WHERE id = ?")) {
        return {
          get(id) {
            expect(id).toBe("detail-1");
            return {
              id,
              timestamp: "2026-04-20T00:00:00.000Z",
              provider: "github",
              model_id: "gh/gpt-5",
              connection_id: "conn-1",
              status: "success",
              latency_json: JSON.stringify({ totalMs: 12 }),
              tokens_json: JSON.stringify({
                prompt_tokens: 10,
                completion_tokens: 20,
              }),
              request_json: JSON.stringify({ prompt: "hello" }),
              provider_request_json: JSON.stringify({ body: { a: 1 } }),
              provider_response_json: JSON.stringify({ body: { b: 2 } }),
              response_json: JSON.stringify({ output: "ok" }),
            };
          },
        };
      }

      if (
        sql.includes("SELECT * FROM request_details ORDER BY timestamp DESC")
      ) {
        return {
          all() {
            throw new Error("full table scan should not be used");
          },
        };
      }

      return {
        all() {
          return [];
        },
        get() {
          return null;
        },
        run() {
          return {};
        },
      };
    });

    vi.doMock("@/lib/sqlite/runtime.js", () => ({
      getSqlite: () => ({
        prepare,
      }),
    }));

    const storeModule = await import("../../src/lib/sqlite/store.js");

    const record = storeModule.getRequestDetailRecord("detail-1");

    expect(record).toMatchObject({
      id: "detail-1",
      provider: "github",
      model: "gh/gpt-5",
      connectionId: "conn-1",
      status: "success",
    });
    expect(record?.latency).toEqual({ totalMs: 12 });
    expect(record?.tokens).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
    });

    const preparedSql = prepare.mock.calls.map(([sql]) => sql);
    expect(
      preparedSql.some(
        (sql) =>
          typeof sql === "string" &&
          sql.includes("SELECT * FROM request_details WHERE id = ?"),
      ),
    ).toBe(true);
    expect(
      preparedSql.some(
        (sql) =>
          typeof sql === "string" &&
          sql.includes("SELECT * FROM request_details ORDER BY timestamp DESC"),
      ),
    ).toBe(false);
  });
});
