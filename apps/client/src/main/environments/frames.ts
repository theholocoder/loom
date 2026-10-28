// The bridge protocol's framing: a 4-byte big-endian length, then that many
// bytes of UTF-8 JSON.

const MAX_FRAME_SIZE = 16 << 20;

export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Collects bytes from a stream and hands back each complete message. */
export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.length >= 4) {
      const size = this.buffered.readUInt32BE(0);
      if (size > MAX_FRAME_SIZE) throw new Error(`bridge sent a ${size} byte frame, over the ${MAX_FRAME_SIZE} byte limit`);
      if (this.buffered.length < 4 + size) break;
      messages.push(JSON.parse(this.buffered.subarray(4, 4 + size).toString('utf8')));
      this.buffered = this.buffered.subarray(4 + size);
    }
    return messages;
  }
}
