import type { Event } from "@packages/shared-types";

export interface SourceAdapter {
  readonly name: string;
  poll(since?: string): Promise<Event[]>;
}

