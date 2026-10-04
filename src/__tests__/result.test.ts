import { describe, it, expect } from "vitest";
import { result } from "../result.js";

describe("result", () => {
  it("serializes data as JSON text", () => {
    expect(result({ a: 1 })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ a: 1 }, null, 2) }],
    });
  });

  it("returns a success payload for void (204) responses", () => {
    const res = result(undefined);
    expect(typeof res.content[0].text).toBe("string");
    expect(JSON.parse(res.content[0].text)).toEqual({ success: true });
  });

  it("keeps null as null", () => {
    expect(result(null).content[0].text).toBe("null");
  });
});
