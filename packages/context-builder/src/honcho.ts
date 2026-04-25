import type { HonchoMemoryDocument } from "@packages/shared-types";

export interface HonchoClientOptions {
  endpoint: string;
  apiKey?: string;
  namespace: string;
}

export class HonchoClient {
  constructor(private readonly options: HonchoClientOptions) {}

  async search(query: string, limit = 5): Promise<HonchoMemoryDocument[]> {
    const response = await fetch(`${this.options.endpoint}/v1/memory/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {})
      },
      body: JSON.stringify({
        namespace: this.options.namespace,
        query,
        limit
      })
    });

    if (!response.ok) {
      throw new Error(`Honcho search failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as HonchoMemoryDocument[];
  }
}

