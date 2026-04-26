import { createId, nowIso } from "@packages/shared-types";

import type { Event } from "@packages/shared-types";

import type { SourceAdapter } from "./base.js";

export class NewsAdapter implements SourceAdapter {
  readonly name = "news-adapter";

  async poll(_since?: string): Promise<Event[]> {
    return [
      {
        id: createId("event"),
        type: "system_health",
        source: this.name,
        symbols: [],
        ts: nowIso(),
        payload: {
          mode: "placeholder",
          note: "Attach your real news source adapter here."
        },
        importance: 0.1,
        dedupeKey: `health:${new Date().toISOString().slice(0, 16)}`
      }
    ];
  }
}
