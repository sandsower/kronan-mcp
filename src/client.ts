const BASE_URL = "https://api.kronan.is";
const REQUEST_TIMEOUT_MS = 30_000;

export class KronanClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request(
    method: string,
    path: string,
    opts?: { body?: unknown; query?: Record<string, string | undefined>; queryArray?: Record<string, string[]> }
  ): Promise<unknown> {
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
      "Content-Type": "application/json",
    };

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

    if (res.status === 204) return { success: true };
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kronan API ${res.status}: ${text}`);
    }
    return res.json();
  }

  // Me
  async getMe() {
    return this.request("GET", "/api/v1/me/");
  }

  // Categories
  async listCategories() {
    return this.request("GET", "/api/v1/categories/");
  }

  async getCategoryProducts(slug: string, page?: number) {
    return this.request("GET", `/api/v1/categories/${encodeURIComponent(slug)}/products/`, {
      query: { page: page?.toString() },
    });
  }

  // Products
  async getProduct(sku: string) {
    return this.request("GET", `/api/v1/products/${encodeURIComponent(sku)}/`);
  }

  async searchProducts(query: string, opts?: { page?: number; pageSize?: number; sortBy?: string; withDetail?: boolean }) {
    return this.request("POST", "/api/v1/products/search/", {
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
  async getCheckout() {
    return this.request("GET", "/api/v1/checkout/");
  }

  async addCheckoutLines(lines: { sku: string; quantity?: number; substitution?: boolean }[], replace: boolean = false) {
    return this.request("POST", "/api/v1/checkout/lines/", {
      body: { lines, replace },
    });
  }

  // Orders
  async listOrders(opts?: { limit?: number; offset?: number; type?: string }) {
    return this.request("GET", "/api/v1/orders/", {
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.offset?.toString(),
        type: opts?.type,
      },
    });
  }

  async getOrder(token: string) {
    return this.request("GET", `/api/v1/orders/${encodeURIComponent(token)}/`);
  }

  async deleteOrderLines(token: string, lineIds: number[]) {
    return this.request("POST", `/api/v1/orders/${encodeURIComponent(token)}/delete-lines/`, {
      body: { lineIds },
    });
  }

  async setOrderSubstitution(token: string, lineIds: number[], substitution: boolean) {
    const order = await this.getOrder(token) as {
      lines: { id: number; substitution: boolean }[];
    };
    const needToggle = lineIds.filter((id) => {
      const line = order.lines.find((l) => l.id === id);
      return line && line.substitution !== substitution;
    });
    if (needToggle.length === 0) return order;
    return this.request("POST", `/api/v1/orders/${encodeURIComponent(token)}/lines-toggle-substitution/`, {
      body: { lineIds: needToggle },
    });
  }

  async lowerOrderQuantity(token: string, lineIds: number[], quantity: number) {
    return this.request("POST", `/api/v1/orders/${encodeURIComponent(token)}/lower-quantity-lines/`, {
      body: { lineIds, quantity },
    });
  }

  // Product Lists
  async listProductLists(opts?: { limit?: number; offset?: number }) {
    return this.request("GET", "/api/v1/product-lists/", {
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.offset?.toString(),
      },
    });
  }

  async createProductList(name: string, description?: string) {
    return this.request("POST", "/api/v1/product-lists/", {
      body: { name, description },
    });
  }

  async getProductList(token: string) {
    return this.request("GET", `/api/v1/product-lists/${encodeURIComponent(token)}/`);
  }

  async updateProductList(token: string, opts: { name?: string; description?: string }) {
    return this.request("PATCH", `/api/v1/product-lists/${encodeURIComponent(token)}/`, {
      body: opts,
    });
  }

  async deleteProductList(token: string) {
    return this.request("DELETE", `/api/v1/product-lists/${encodeURIComponent(token)}/`);
  }

  async clearProductList(token: string) {
    return this.request("DELETE", `/api/v1/product-lists/${encodeURIComponent(token)}/delete-all-items/`);
  }

  async sortProductListItems(token: string) {
    return this.request("POST", `/api/v1/product-lists/${encodeURIComponent(token)}/sort-items/`, {
      body: {},
    });
  }

  async updateProductListItem(token: string, sku: string, quantity: number) {
    return this.request("POST", `/api/v1/product-lists/${encodeURIComponent(token)}/update-item/`, {
      body: { sku, quantity },
    });
  }

  // Purchase Stats
  async listPurchaseStats(opts?: { limit?: number; offset?: number; includeIgnored?: boolean }) {
    return this.request("GET", "/api/v1/product-purchase-stats/", {
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.offset?.toString(),
        include_ignored: opts?.includeIgnored?.toString(),
      },
    });
  }

  async setPurchaseStatIgnored(id: number, isIgnored: boolean) {
    return this.request("PATCH", `/api/v1/product-purchase-stats/${id}/set-ignored/`, {
      body: { isIgnored },
    });
  }

  // Shopping Notes
  async getShoppingNote() {
    return this.request("GET", "/api/v1/shopping-notes/");
  }

  async addShoppingNoteLine(opts: { text?: string; sku?: string; quantity?: number }) {
    return this.request("POST", "/api/v1/shopping-notes/add-line/", {
      body: opts,
    });
  }

  async changeShoppingNoteLine(token: string, opts: { text?: string; quantity?: number }) {
    return this.request("PATCH", "/api/v1/shopping-notes/change-line/", {
      body: { token, ...opts },
    });
  }

  async reorderShoppingNoteLines(linesTokens: string[]) {
    return this.request("PATCH", "/api/v1/shopping-notes/change-placement/", {
      queryArray: { lines_tokens: linesTokens },
      body: {},
    });
  }

  async deleteShoppingNoteLine(token: string) {
    return this.request("DELETE", "/api/v1/shopping-notes/delete-line/", {
      query: { token },
    });
  }

  async deleteArchivedLine(token: string) {
    return this.request("DELETE", "/api/v1/shopping-notes/delete-line-archived/", {
      query: { token },
    });
  }

  async clearShoppingNote() {
    return this.request("DELETE", "/api/v1/shopping-notes/delete-shopping-note/");
  }

  async checkStoreOrderEligibility(): Promise<{ eligible: boolean; detail?: string }> {
    const url = new URL("/api/v1/shopping-notes/is-eligible-for-store-product-order/", BASE_URL);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `AccessToken ${this.token}` },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Kronan API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: GET eligibility check`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 204) return { eligible: true };
    if (res.status === 404) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { eligible: false, detail: (body.detail as string) ?? "No matching products found" };
    }
    const text = await res.text();
    throw new Error(`Kronan API ${res.status}: ${text}`);
  }

  async listArchivedLines() {
    return this.request("GET", "/api/v1/shopping-notes/lines-archived/");
  }

  async applyStoreProductOrder() {
    return this.request("POST", "/api/v1/shopping-notes/store-product-order/", {
      body: {},
    });
  }

  async setLineCompletion(lineToken: string, completed: boolean) {
    const notes = await this.getShoppingNote() as {
      lines: { token: string; isCompleted: boolean }[];
    }[];
    const note = Array.isArray(notes) ? notes[0] : notes;
    const line = (note as { lines: { token: string; isCompleted: boolean }[] }).lines.find(
      (l) => l.token === lineToken
    );
    if (!line) throw new Error(`Shopping note line ${lineToken} not found`);
    if (line.isCompleted === completed) return note;
    return this.request("PATCH", "/api/v1/shopping-notes/toggle-complete-on-line/", {
      body: { token: lineToken },
    });
  }
}
