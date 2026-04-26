import type { Event } from "@packages/shared-types";

import type { SourceAdapter } from "./base.js";

export class CalendarAdapter implements SourceAdapter {
  readonly name = "calendar-adapter";

  async poll(_since?: string): Promise<Event[]> {
    return [];
  }
}
