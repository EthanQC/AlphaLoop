import type { Event } from "@packages/shared-types";

import type { SourceAdapter } from "./base.js";

export class PriceAdapter implements SourceAdapter {
  readonly name = "price-adapter";

  async poll(_since?: string): Promise<Event[]> {
    return [];
  }
}
