import type {
  HttpMethod,
  PaginatedResponse,
  PublicCategory,
  PublicCategoryProductList,
  PublicCheckout,
  PublicMe,
  PublicOrder,
  PublicOrderSummary,
  PublicPaginatedSearchResult,
  PublicProductDetail,
  PublicProductList,
  PublicProductListDetail,
  PublicProductListWithCount,
  PublicProductPurchaseStats,
  PublicShoppingNote,
  PublicShoppingNoteLineArchived,
  StoreOrderEligibility,
} from "./types.js";

const BASE_URL = "https://api.kronan.is";
const REQUEST_TIMEOUT_MS = 30_000;

export class KronanApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Kronan API ${status}: ${body}`);
    this.name = "KronanApiError";
  }
}

export class KronanClient {
  private readonly token: string;

  constructor(token: string) {
    if (!token.trim()) {
      throw new Error("KronanClient token must be non-empty");
    }
    this.token = token;
  }

  private scrubToken(text: string): string {
    return text.replaceAll(this.token, "[REDACTED]");
  }

  private async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts?: { body?: unknown; query?: Record<string, string | undefined>; queryArray?: Record<string, string[]> }
  ): Promise<T> {
    const url = new URL(path, BASE_URL);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    if (opts?.queryArray) {
      for (const [k, values] of Object.entries(opts.queryArray)) {
        for (const v of values) {
          url.searchParams.append(k, v);
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `AccessToken ${this.token}`,
    };
    if (opts?.body) {
      headers["Content-Type"] = "application/json";
    }

    const isMutation = method !== "GET";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        if (isMutation) {
          throw new Error(
            `Kronan API mutation timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${path}. ` +
            `OUTCOME UNKNOWN — the server may have already applied this change. Do NOT retry without first checking current state.`
          );
        }
        throw new Error(`Kronan API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 204) return undefined as T;

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      throw new Error(
        `Kronan API rate limit exceeded. ${retryAfter ? `Retry after ${retryAfter} seconds.` : "Wait before retrying."} Limit: 200 requests per 200 seconds.`
      );
    }

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new KronanApiError(res.status, "(response body unreadable)");
      }
      throw new KronanApiError(res.status, this.scrubToken(text).slice(0, 500));
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Kronan API returned non-JSON response for ${method} ${path} (status ${res.status}): ${this.scrubToken(text).slice(0, 500)}`
      );
    }
  }

  // Me
  async getMe(): Promise<PublicMe> {
    return this.request<PublicMe>("GET", "/api/v1/me/");
  }

  // Categories
  async listCategories(): Promise<PublicCategory[]> {
    return this.request<PublicCategory[]>("GET", "/api/v1/categories/");
  }

  async getCategoryProducts(slug: string, page?: number): Promise<PublicCategoryProductList> {
    return this.request<PublicCategoryProductList>("GET", `/api/v1/categories/${encodeURIComponent(slug)}/products/`, {
      query: { page: page?.toString() },
    });
  }

  // Products
  async getProduct(sku: string): Promise<PublicProductDetail> {
    return this.request<PublicProductDetail>("GET", `/api/v1/products/${encodeURIComponent(sku)}/`);
  }

  async searchProducts(query: string, opts?: { page?: number; pageSize?: number; sortBy?: string; withDetail?: boolean }): Promise<PublicPaginatedSearchResult> {
    return this.request<PublicPaginatedSearchResult>("POST", "/api/v1/products/search/", {
      body: {
        query,
        page: opts?.page,
        pageSize: opts?.pageSize,
        sortBy: opts?.sortBy,
        withDetail: opts?.withDetail,
      },
    });
  }

  // Checkout
  async getCheckout(): Promise<PublicCheckout> {
    return this.request<PublicCheckout>("GET", "/api/v1/checkout/");
  }

  async addCheckoutLines(lines: { sku: string; quantity?: number; substitution?: boolean }[], replace: boolean = false): Promise<PublicCheckout> {
    return this.request<PublicCheckout>("POST", "/api/v1/checkout/lines/", {
      body: { lines, replace },
    });
  }

  // Orders
  async listOrders(opts?: { limit?: number; offset?: number; type?: string }): Promise<PaginatedResponse<PublicOrderSummary>> {
    return this.request<PaginatedResponse<PublicOrderSummary>>("GET", "/api/v1/orders/", {
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.offset?.toString(),
        type: opts?.type,
      },
    });
  }

  async getOrder(token: string): Promise<PublicOrder> {
    return this.request<PublicOrder>("GET", `/api/v1/orders/${encodeURIComponent(token)}/`);
  }

  async deleteOrderLines(token: string, lineIds: number[]): Promise<PublicOrder> {
    return this.request<PublicOrder>("POST", `/api/v1/orders/${encodeURIComponent(token)}/delete-lines/`, {
      body: { lineIds },
    });
  }

  async setOrderSubstitution(token: string, lineIds: number[], substitution: boolean): Promise<PublicOrder> {
    const raw = await this.getOrder(token);
    const order = raw as unknown as Record<string, unknown>;
    if (!order || !Array.isArray(order.lines)) {
      throw new Error(
        `Unexpected response from getOrder: order does not contain a lines array`
      );
    }

    for (const item of order.lines) {
      if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).id !== "number") {
        throw new Error(
          `Unexpected order line format: expected objects with numeric id`
        );
      }
    }
    const lines = order.lines as PublicOrder["lines"];

    const missingIds = lineIds.filter((id) => !lines.some((l) => l.id === id));
    if (missingIds.length > 0) {
      const availableIds = lines.map((l) => l.id);
      throw new Error(
        `Line IDs [${missingIds.join(", ")}] not found in order ${token}. Available line IDs: [${availableIds.join(", ")}]`
      );
    }

    const needToggle = lineIds.filter((id) => {
      const line = lines.find((l) => l.id === id);
      return line && line.substitution !== substitution;
    });
    if (needToggle.length === 0) return raw;

    return this.request<PublicOrder>("POST", `/api/v1/orders/${encodeURIComponent(token)}/lines-toggle-substitution/`, {
      body: { lineIds: needToggle },
    });
  }

  async lowerOrderQuantity(token: string, lineIds: number[], quantity: number): Promise<PublicOrder> {
    return this.request<PublicOrder>("POST", `/api/v1/orders/${encodeURIComponent(token)}/lower-quantity-lines/`, {
      body: { lineIds, quantity },
    });
  }

  // Product Lists
  async listProductLists(opts?: { limit?: number; offset?: number }): Promise<PaginatedResponse<PublicProductListWithCount>> {
    return this.request<PaginatedResponse<PublicProductListWithCount>>("GET", "/api/v1/product-lists/", {
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.offset?.toString(),
      },
    });
  }

  async createProductList(name: string, description?: string): Promise<PublicProductList> {
    return this.request<PublicProductList>("POST", "/api/v1/product-lists/", {
      body: { name, description },
    });
  }

  async getProductList(token: string): Promise<PublicProductListDetail> {
    return this.request<PublicProductListDetail>("GET", `/api/v1/product-lists/${encodeURIComponent(token)}/`);
  }

  async updateProductList(token: string, opts: { name?: string; description?: string }): Promise<PublicProductList> {
    return this.request<PublicProductList>("PATCH", `/api/v1/product-lists/${encodeURIComponent(token)}/`, {
      body: opts,
    });
  }

  async deleteProductList(token: string): Promise<void> {
    await this.request("DELETE", `/api/v1/product-lists/${encodeURIComponent(token)}/`);
  }

  async clearProductList(token: string): Promise<void> {
    await this.request("DELETE", `/api/v1/product-lists/${encodeURIComponent(token)}/delete-all-items/`);
  }

  async sortProductListItems(token: string): Promise<PublicProductListDetail> {
    return this.request<PublicProductListDetail>("POST", `/api/v1/product-lists/${encodeURIComponent(token)}/sort-items/`, {
      body: {},
    });
  }

  async updateProductListItem(token: string, sku: string, quantity: number): Promise<PublicProductListDetail> {
    return this.request<PublicProductListDetail>("POST", `/api/v1/product-lists/${encodeURIComponent(token)}/update-item/`, {
      body: { sku, quantity },
    });
  }

  // Purchase Stats
  async listPurchaseStats(opts?: { limit?: number; offset?: number; includeIgnored?: boolean }): Promise<PaginatedResponse<PublicProductPurchaseStats>> {
    return this.request<PaginatedResponse<PublicProductPurchaseStats>>("GET", "/api/v1/product-purchase-stats/", {
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.offset?.toString(),
        include_ignored: opts?.includeIgnored?.toString(),
      },
    });
  }

  async setPurchaseStatIgnored(id: number, isIgnored: boolean): Promise<PublicProductPurchaseStats> {
    return this.request<PublicProductPurchaseStats>("PATCH", `/api/v1/product-purchase-stats/${encodeURIComponent(id)}/set-ignored/`, {
      body: { isIgnored },
    });
  }

  // Shopping Notes
  async getShoppingNote(): Promise<PublicShoppingNote[]> {
    return this.request<PublicShoppingNote[]>("GET", "/api/v1/shopping-notes/");
  }

  async addShoppingNoteLine(opts: { text?: string; sku?: string; quantity?: number }): Promise<PublicShoppingNote> {
    return this.request<PublicShoppingNote>("POST", "/api/v1/shopping-notes/add-line/", {
      body: opts,
    });
  }

  async changeShoppingNoteLine(token: string, opts: { text?: string; quantity?: number }): Promise<PublicShoppingNote> {
    return this.request<PublicShoppingNote>("PATCH", "/api/v1/shopping-notes/change-line/", {
      body: { token, ...opts },
    });
  }

  async reorderShoppingNoteLines(linesTokens: string[]): Promise<PublicShoppingNote> {
    return this.request<PublicShoppingNote>("PATCH", "/api/v1/shopping-notes/change-placement/", {
      queryArray: { lines_tokens: linesTokens },
      body: {},
    });
  }

  async deleteShoppingNoteLine(token: string): Promise<void> {
    await this.request("DELETE", "/api/v1/shopping-notes/delete-line/", {
      query: { token },
    });
  }

  async deleteArchivedLine(token: string): Promise<void> {
    await this.request("DELETE", "/api/v1/shopping-notes/delete-line-archived/", {
      query: { token },
    });
  }

  async clearShoppingNote(): Promise<void> {
    await this.request("DELETE", "/api/v1/shopping-notes/delete-shopping-note/");
  }

  async checkStoreOrderEligibility(): Promise<StoreOrderEligibility> {
    try {
      await this.request("GET", "/api/v1/shopping-notes/is-eligible-for-store-product-order/");
      return { eligible: true };
    } catch (err: unknown) {
      if (err instanceof KronanApiError && err.status === 404) {
        try {
          const body = JSON.parse(err.body) as Record<string, unknown>;
          return { eligible: false, detail: (body.detail as string) ?? "No matching products found" };
        } catch {
          return { eligible: false, detail: `API returned non-JSON 404 response: ${err.body.slice(0, 200)}` };
        }
      }
      throw err;
    }
  }

  async listArchivedLines(): Promise<PublicShoppingNoteLineArchived[]> {
    return this.request<PublicShoppingNoteLineArchived[]>("GET", "/api/v1/shopping-notes/lines-archived/");
  }

  async applyStoreProductOrder(): Promise<PublicShoppingNote> {
    return this.request<PublicShoppingNote>("POST", "/api/v1/shopping-notes/store-product-order/", {
      body: {},
    });
  }

  async setLineCompletion(lineToken: string, completed: boolean): Promise<PublicShoppingNote> {
    const raw = await this.getShoppingNote();

    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("No shopping note found");
    }

    const first = raw[0];
    if (typeof first !== "object" || first === null) {
      throw new Error(`Unexpected shopping note format: expected an object, got ${typeof first}`);
    }
    const note = first as unknown as Record<string, unknown>;
    if (!Array.isArray(note.lines)) {
      throw new Error("Shopping note does not contain a lines array");
    }

    const lines = note.lines as PublicShoppingNote["lines"];
    const line = lines.find((l) => l.token === lineToken);
    if (!line) throw new Error(`Shopping note line ${lineToken} not found`);
    if (typeof line.isCompleted !== "boolean") {
      throw new Error(
        `Shopping note line ${lineToken} has no isCompleted field — cannot determine current state. Check the line manually before retrying.`
      );
    }
    if (line.isCompleted === completed) return note as unknown as PublicShoppingNote;

    return this.request<PublicShoppingNote>("PATCH", "/api/v1/shopping-notes/toggle-complete-on-line/", {
      body: { token: lineToken },
    });
  }
}
