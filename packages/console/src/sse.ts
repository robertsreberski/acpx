export interface SseWritable {
  write(chunk: string): boolean;
}

export interface DisconnectableSseWritable extends SseWritable {
  destroy(): void;
}

export interface SseFrame<TEvent extends { type: string } = { type: string }> {
  id: number;
  event: TEvent;
}

/**
 * Write an SSE event as one frame so the caller can honor Node's backpressure
 * signal. Splitting a frame across several writes can return false halfway
 * through and still enqueue the remaining fields on an already-slow client.
 */
export function writeSseFrame<TEvent extends { type: string }>(
  writable: SseWritable,
  item: SseFrame<TEvent>,
): boolean {
  return writable.write(
    `id: ${item.id}\nevent: ${item.event.type}\ndata: ${JSON.stringify(item.event)}\n\n`,
  );
}

export function writeSseFrameOrDisconnect<TEvent extends { type: string }>(
  writable: DisconnectableSseWritable,
  item: SseFrame<TEvent>,
): boolean {
  const accepted = writeSseFrame(writable, item);
  if (!accepted) {
    writable.destroy();
  }
  return accepted;
}
