/** Shapes for the WebRTC position layer. Anything sent through a Trystero action
 * must be JSON-serializable (`type`, not `interface`); `Player` itself is never
 * sent directly, so it may stay an interface. Room/chat/world shapes live in
 * `src/app/room/room.types.ts`. */

export interface Player {
  id: string;
  name: string;
  /** World-space position [x, y, z]. */
  pos: [number, number, number];
  /** Heading in radians about the Y axis. */
  rotY: number;
}
