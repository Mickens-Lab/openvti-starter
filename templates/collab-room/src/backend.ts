// What the UI needs from a backend: the rooms to pick from and a RoomSession for one of them. Two implementations:
// src/mock.ts (in-browser MockRoomHost, the default) and src/live.ts (VTC + VTA, unverified live).
import type { RoomSession, Visibility } from "@starter/rooms-client";

export interface RoomRef {
  roomId: string;
  label: string;
  /** Known from the memberships list or the mock; otherwise rooms/info tells it when the room opens. */
  visibility?: Visibility;
  description?: string;
}

export interface Backend {
  mode: "mock" | "live";
  /** The member's DID: signs host documents, shown as "You". */
  self: string;
  rooms(): Promise<RoomRef[]>;
  open(ref: RoomRef): Promise<RoomSession>;
  /** Stop background work (the mock's simulated member). */
  close(): void;
}
