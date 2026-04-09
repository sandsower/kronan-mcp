import { describe, it, expect, vi, afterEach } from "vitest";
import { KronanClient, KronanApiError } from "../client.js";

/** Mock fetch with a response. For 200 responses, pass `data` and it auto-serializes to text(). */
function mockFetch(opts: {
  status?: number;
  ok?: boolean;
  headers?: Headers;
  data?: unknown;
  text?: string;
  textError?: boolean;
}) {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const body = opts.text ?? (opts.data !== undefined ? JSON.stringify(opts.data) : "");
  const res = {
    ok,
    status,
    headers: opts.headers ?? new Headers(),
    text: opts.textError
      ? () => Promise.reject(new Error("stream error"))
      : () => Promise.resolve(body),
  } as Response;
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(res);
}

/** Mock fetch that returns different responses on sequential calls */
function mockFetchSequence(responses: Array<{ data?: unknown; status?: number }>) {
  let callCount = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const resp = responses[callCount] ?? responses[responses.length - 1];
    callCount++;
    return {
      ok: (resp.status ?? 200) >= 200 && (resp.status ?? 200) < 300,
      status: resp.status ?? 200,
      headers: new Headers(),
      text: () => Promise.resolve(resp.data !== undefined ? JSON.stringify(resp.data) : ""),
    } as Response;
  });
}

describe("KronanClient constructor", () => {
  it("throws on empty string token", () => {
    expect(() => new KronanClient("")).toThrow("token must be non-empty");
  });

  it("throws on whitespace-only token", () => {
    expect(() => new KronanClient("   ")).toThrow("token must be non-empty");
  });

  it("accepts a valid token", () => {
    expect(() => new KronanClient("valid-token")).not.toThrow();
  });
});

describe("KronanClient.request()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("sends Authorization header with AccessToken prefix", async () => {
    fetchSpy = mockFetch({ data: { type: "user", name: "Test" } });
    const client = new KronanClient("my-token");
    await client.getMe();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("AccessToken my-token");
  });

  it("returns parsed JSON on 200", async () => {
    const data = { type: "user", name: "Test" };
    fetchSpy = mockFetch({ data });
    const client = new KronanClient("tok");
    const result = await client.getMe();
    expect(result).toEqual(data);
  });

  it("returns undefined on 204", async () => {
    fetchSpy = mockFetch({ status: 204 });
    const client = new KronanClient("tok");
    const result = await client.deleteProductList("abc");
    expect(result).toBeUndefined();
  });

  it("throws with context when JSON parsing fails on 200", async () => {
    fetchSpy = mockFetch({ text: "<html>Bad Gateway</html>" });
    const client = new KronanClient("tok");
    await expect(client.getMe()).rejects.toThrow(/non-JSON response.*GET.*\/api\/v1\/me/);
  });

  it("throws on 429 with retry guidance when Retry-After present", async () => {
    const headers = new Headers({ "Retry-After": "30" });
    fetchSpy = mockFetch({ status: 429, headers, text: "Rate limited" });
    const client = new KronanClient("tok");
    await expect(client.getMe()).rejects.toThrow(/rate limit exceeded.*Retry after 30 seconds/);
  });

  it("throws on 429 with generic wait message when no Retry-After", async () => {
    fetchSpy = mockFetch({ status: 429, text: "Rate limited" });
    const client = new KronanClient("tok");
    await expect(client.getMe()).rejects.toThrow(/rate limit exceeded.*Wait before retrying/);
  });

  it("preserves status code when res.text() fails in error path", async () => {
    fetchSpy = mockFetch({ status: 500, textError: true });
    const client = new KronanClient("tok");
    await expect(client.getMe()).rejects.toThrow(/Kronan API 500.*response body unreadable/);
    try {
      await client.getMe();
    } catch (err) {
      expect(err).toBeInstanceOf(KronanApiError);
      expect((err as KronanApiError).status).toBe(500);
    }
  });

  it("throws KronanApiError with status and body on non-ok response", async () => {
    fetchSpy = mockFetch({ status: 403, text: '{"detail":"Forbidden"}' });
    const client = new KronanClient("tok");
    try {
      await client.getMe();
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KronanApiError);
      expect((err as KronanApiError).status).toBe(403);
      expect((err as KronanApiError).body).toBe('{"detail":"Forbidden"}');
    }
  });

  it("scrubs token from error response bodies", async () => {
    const secret = "my-secret-token-123";
    fetchSpy = mockFetch({ status: 500, text: `Error: token ${secret} is invalid` });
    const client = new KronanClient(secret);
    try {
      await client.getMe();
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KronanApiError);
      expect((err as KronanApiError).body).not.toContain(secret);
      expect((err as KronanApiError).body).toContain("[REDACTED]");
    }
  });

  it("scrubs token from non-JSON response errors", async () => {
    const secret = "my-secret-token-456";
    fetchSpy = mockFetch({ text: `<html>Token: ${secret}</html>` });
    const client = new KronanClient(secret);
    await expect(client.getMe()).rejects.toThrow(/\[REDACTED\]/);
    await expect(client.getMe()).rejects.not.toThrow(secret);
  });

  it("distinguishes mutation timeout from read timeout", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
    });

    const client = new KronanClient("tok");

    // Read timeout
    await expect(client.getMe()).rejects.toThrow(/timed out/);
    await expect(client.getMe()).rejects.not.toThrow(/OUTCOME UNKNOWN/);

    // Mutation timeout — use addCheckoutLines which is a POST
    await expect(client.addCheckoutLines([{ sku: "123" }])).rejects.toThrow(/OUTCOME UNKNOWN/);
  });
});

describe("KronanClient.setOrderSubstitution()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("throws when requested lineIds are not found in order", async () => {
    const order = {
      token: "order-1",
      lines: [{ id: 1, substitution: false, productName: "Milk", sku: "100", quantity: 1, unitPrice: 200, isMutable: true, substitutionForLineId: null, thumbnail: "", total: 200 }],
      total: 200, discount: 0, created: "2026-01-01T00:00:00Z", allowAlterOrderLines: true,
    };
    fetchSpy = mockFetch({ data: order });
    const client = new KronanClient("tok");
    await expect(client.setOrderSubstitution("order-1", [1, 99, 100], true)).rejects.toThrow(
      /Line IDs \[99, 100\] not found in order/
    );
  });

  it("validates that API response has a lines array", async () => {
    fetchSpy = mockFetch({ data: { detail: "Not found" } });
    const client = new KronanClient("tok");
    await expect(client.setOrderSubstitution("bad-token", [1], true)).rejects.toThrow(
      /Unexpected response.*order does not contain a lines array/
    );
  });

  it("throws when order lines have unexpected format", async () => {
    const order = {
      token: "order-1",
      lines: [{ name: "bad line" }], // missing numeric id
      total: 200, discount: 0, created: "2026-01-01T00:00:00Z", allowAlterOrderLines: true,
    };
    fetchSpy = mockFetch({ data: order });
    const client = new KronanClient("tok");
    await expect(client.setOrderSubstitution("order-1", [1], true)).rejects.toThrow(
      /Unexpected order line format/
    );
  });

  it("returns order when lines already in desired state", async () => {
    const order = {
      token: "order-1",
      lines: [{ id: 1, substitution: true }],
      total: 200, discount: 0, created: "2026-01-01T00:00:00Z", allowAlterOrderLines: true,
    };
    fetchSpy = mockFetch({ data: order });
    const client = new KronanClient("tok");
    const result = await client.setOrderSubstitution("order-1", [1], true);
    expect(result).toEqual(order);
    expect(fetchSpy).toHaveBeenCalledOnce(); // only the GET, no toggle POST
  });

  it("sends toggle only for lines that differ", async () => {
    const order = {
      token: "order-1",
      lines: [
        { id: 1, substitution: false },
        { id: 2, substitution: true },
        { id: 3, substitution: false },
      ],
      total: 600, discount: 0, created: "2026-01-01T00:00:00Z", allowAlterOrderLines: true,
    };
    const toggledOrder = { ...order, lines: order.lines.map((l) => ({ ...l, substitution: true })) };

    fetchSpy = mockFetchSequence([{ data: order }, { data: toggledOrder }]);

    const client = new KronanClient("tok");
    await client.setOrderSubstitution("order-1", [1, 2, 3], true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, toggleInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(toggleInit.body as string);
    expect(body.lineIds).toEqual([1, 3]); // only the ones that were false
  });
});

describe("KronanClient.setLineCompletion()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("throws when API response is empty array", async () => {
    fetchSpy = mockFetch({ data: [] });
    const client = new KronanClient("tok");
    await expect(client.setLineCompletion("line-tok", true)).rejects.toThrow(/No shopping note found/);
  });

  it("throws when response note has no lines array", async () => {
    fetchSpy = mockFetch({ data: [{ token: "note-1", name: "My Note" }] });
    const client = new KronanClient("tok");
    await expect(client.setLineCompletion("line-tok", true)).rejects.toThrow(
      /Shopping note does not contain a lines array/
    );
  });

  it("throws when note element is not an object", async () => {
    fetchSpy = mockFetch({ data: ["unexpected"] });
    const client = new KronanClient("tok");
    await expect(client.setLineCompletion("line-tok", true)).rejects.toThrow(
      /Unexpected shopping note format/
    );
  });

  it("throws when isCompleted field is missing on the line", async () => {
    const notes = [{ token: "note-1", name: "My Note", lines: [{ token: "line-1" }] }];
    fetchSpy = mockFetch({ data: notes });
    const client = new KronanClient("tok");
    await expect(client.setLineCompletion("line-1", true)).rejects.toThrow(
      /has no isCompleted field/
    );
  });

  it("throws when line token is not found", async () => {
    const notes = [{ token: "note-1", name: "My Note", lines: [{ token: "other-line", isCompleted: false }] }];
    fetchSpy = mockFetch({ data: notes });
    const client = new KronanClient("tok");
    await expect(client.setLineCompletion("missing-line", true)).rejects.toThrow(
      /Shopping note line missing-line not found/
    );
  });

  it("returns note when line already in desired state", async () => {
    const notes = [{ token: "note-1", name: "My Note", lines: [{ token: "line-1", isCompleted: true }] }];
    fetchSpy = mockFetch({ data: notes });
    const client = new KronanClient("tok");
    const result = await client.setLineCompletion("line-1", true);
    expect(result).toEqual(notes[0]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("sends toggle when line state differs", async () => {
    const notes = [{ token: "note-1", name: "My Note", lines: [{ token: "line-1", isCompleted: false }] }];
    const toggledNote = { token: "note-1", name: "My Note", lines: [{ token: "line-1", isCompleted: true }] };

    fetchSpy = mockFetchSequence([{ data: notes }, { data: toggledNote }]);

    const client = new KronanClient("tok");
    await client.setLineCompletion("line-1", true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("toggle-complete-on-line");
  });
});

describe("KronanClient.checkStoreOrderEligibility()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("returns eligible: true on 204", async () => {
    fetchSpy = mockFetch({ status: 204 });
    const client = new KronanClient("tok");
    const result = await client.checkStoreOrderEligibility();
    expect(result).toEqual({ eligible: true });
  });

  it("returns eligible: false with detail on 404 JSON body", async () => {
    fetchSpy = mockFetch({
      status: 404,
      text: JSON.stringify({ detail: "No matching products" }),
    });
    const client = new KronanClient("tok");
    const result = await client.checkStoreOrderEligibility();
    expect(result).toEqual({ eligible: false, detail: "No matching products" });
  });

  it("returns descriptive detail when 404 body is not JSON", async () => {
    fetchSpy = mockFetch({ status: 404, text: "<html>Not Found</html>" });
    const client = new KronanClient("tok");
    const result = await client.checkStoreOrderEligibility();
    expect(result.eligible).toBe(false);
    expect(result.detail).toContain("non-JSON");
  });

  it("throws on non-204/404 errors", async () => {
    fetchSpy = mockFetch({ status: 500, text: "Internal Server Error" });
    const client = new KronanClient("tok");
    await expect(client.checkStoreOrderEligibility()).rejects.toThrow(/Kronan API 500/);
  });
});

describe("KronanClient.setPurchaseStatIgnored()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("encodes the id in the URL path", async () => {
    fetchSpy = mockFetch({ data: { id: 42, isIgnored: true } });
    const client = new KronanClient("tok");
    await client.setPurchaseStatIgnored(42, true);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/product-purchase-stats/42/set-ignored/");
  });
});
