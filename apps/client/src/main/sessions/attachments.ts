// Attachments: the files and images the user sends with a message. Main keeps
// them in the attachments folder in `userData`, one folder per Session, each
// file named by its content's hash; transcript events and queued messages
// refer to them. They reach the agent by being put into the Session's
// Environment by its bridge, where it reads them: copied there by a bridge
// on this machine, sent in chunks to one elsewhere.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  bytesLabel,
  isImage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_INLINE_IMAGE_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_PASTED_ATTACHMENT_BYTES,
  type Attachment,
  type NewAttachment,
} from '../../shared/api';
import type { PromptFile } from '../agents/adapter';
import type { BridgeCall } from '../environments/exec';

/** The folder in `userData` attachments are kept in. */
export const ATTACHMENTS_FOLDER = 'attachments';

/** How many bytes of a file go in one `files.upload.chunk`: few enough that a ping behind it is never late. */
const CHUNK_BYTES = 1024 * 1024;

/** How long the bridge gets to write one chunk, or to put a whole upload in place. */
const CHUNK_TIMEOUT_MS = 30_000;

/** How long the bridge gets to start an upload or a copy, hashing the file already there first. */
const COPY_TIMEOUT_MS = 5 * 60_000;

/** How long the bridge gets to remove a Session's copies. */
const REMOVE_TIMEOUT_MS = 60_000;

/** Media types by file extension, for a file the renderer gave none. */
const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  zip: 'application/zip',
  csv: 'text/csv',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
};

/** What delivering attachments needs of the Session's Environment. */
export interface AttachmentEnvironment {
  request: BridgeCall;
  /** The folder the agent's copies go in there, one folder per Session. */
  folder: string;
  /** Whether its bridge runs on this machine, and so copies from `userData` itself. */
  local: boolean;
}

export class Attachments {
  /** `userDataDir` is where the attachments folder goes. */
  constructor(private readonly userDataDir: string) {}

  /**
   * Stores the files attached to a message of the Session `sessionId`, once
   * each: the same content attached again is the same file. A file is
   * streamed in, never held whole.
   */
  async store(sessionId: number, attachments: NewAttachment[]): Promise<Attachment[]> {
    const stored: Attachment[] = [];
    const folder = join(this.userDataDir, ATTACHMENTS_FOLDER, String(sessionId));
    for (const attachment of attachments) {
      await mkdir(folder, { recursive: true });
      // Written beside its place and renamed in, so a crash never leaves half a file under its hash.
      const partial = join(folder, `${randomUUID()}.partial`);
      const hash = createHash('sha256');
      let size = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.byteLength;
          if (size > MAX_ATTACHMENT_BYTES) return done(new Error(`"${attachment.name}" grew over ${bytesLabel(MAX_ATTACHMENT_BYTES)} as it was attached.`));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      const source = 'path' in attachment ? createReadStream(attachment.path) : Readable.from([Buffer.from(attachment.data)]);
      try {
        await pipeline(source, counted, createWriteStream(partial));
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
      const name = fileName(attachment.name);
      const kept: Attachment = { name, mimeType: mimeTypeOf(name, attachment.mimeType), size, hash: hash.digest('hex') };
      await rename(partial, this.path(sessionId, kept));
      stored.push(kept);
    }
    return stored;
  }

  /**
   * Puts the Session's attachments into its Environment, under
   * `<folder>/<session>/<hash>/<name>`, where the agent works freely, and
   * says where they are. One already there, as the agent last had it, is
   * left; one changed since is replaced. `signal` stops it partway.
   */
  async deliver(sessionId: number, attachments: Attachment[], environment: AttachmentEnvironment, signal?: AbortSignal): Promise<PromptFile[]> {
    const files: PromptFile[] = [];
    for (const attachment of attachments) {
      signal?.throwIfAborted();
      const { name, mimeType, size, hash } = attachment;
      const source = this.path(sessionId, attachment);
      const path = `${environment.folder}/${sessionId}/${hash}/${name}`;
      if (environment.local) await environment.request('files.copyTo', COPY_TIMEOUT_MS, { from: source, to: path, size, sha256: hash });
      else await upload(environment.request, source, path, attachment, signal);
      // Only a small image's content is kept for the agent; it reads the rest from its copy.
      const inline = isImage(mimeType) && size <= MAX_INLINE_IMAGE_BYTES;
      files.push({ path, name, mimeType, size, ...(inline ? { data: await readFile(source) } : {}) });
    }
    return files;
  }

  /** Removes every attachment of the Session kept in `userData`. */
  async remove(sessionId: number): Promise<void> {
    await rm(join(this.userDataDir, ATTACHMENTS_FOLDER, String(sessionId)), { recursive: true, force: true });
  }

  /** Removes the Session's copies in its Environment. */
  async removeCopies(sessionId: number, environment: Pick<AttachmentEnvironment, 'request' | 'folder'>): Promise<void> {
    await environment.request('files.remove', REMOVE_TIMEOUT_MS, { path: `${environment.folder}/${sessionId}` });
  }

  private path(sessionId: number, { hash, name }: Pick<Attachment, 'hash' | 'name'>): string {
    return join(this.userDataDir, ATTACHMENTS_FOLDER, String(sessionId), `${hash}${extensionOf(name)}`);
  }
}

/**
 * Sends a stored file to `path` in the Environment in chunks, one at a time,
 * read into one buffer; nothing when the bridge says it is there already.
 */
async function upload(request: BridgeCall, source: string, path: string, { name, size, hash }: Attachment, signal: AbortSignal | undefined): Promise<void> {
  const begun = await request<{ upload?: string; present: boolean }>('files.upload.begin', COPY_TIMEOUT_MS, { path, size, sha256: hash });
  if (begun.present) return;
  const file = await open(source, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size));
    for (let offset = 0; offset < size; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw new Error(`"${name}" is shorter than when it was attached.`);
      await request('files.upload.chunk', CHUNK_TIMEOUT_MS, { upload: begun.upload, offset, data: buffer.subarray(0, bytesRead).toString('base64') });
      offset += bytesRead;
    }
    await request('files.upload.end', CHUNK_TIMEOUT_MS, { upload: begun.upload });
  } catch (error) {
    void request('files.upload.abort', CHUNK_TIMEOUT_MS, { upload: begun.upload }).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
}

/**
 * Rejects what can't be attached: anything but a list of named files, more
 * than MAX_ATTACHMENTS of them, a path that is not a file, one over
 * MAX_ATTACHMENT_BYTES (MAX_PASTED_ATTACHMENT_BYTES sent as bytes), or more
 * than MAX_MESSAGE_ATTACHMENT_BYTES in all.
 */
export async function checkAttachments(attachments: unknown): Promise<NewAttachment[]> {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) throw new Error('Attachments come as a list of files.');
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
  let total = 0;
  for (const attachment of attachments as Array<{ name?: unknown; mimeType?: unknown; path?: unknown; data?: unknown } | null>) {
    if (typeof attachment?.name !== 'string' || !fileName(attachment.name)) throw new Error('An attachment needs a file name.');
    if (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string') throw new Error(`The media type of "${attachment.name}" must be text.`);
    const tooBig = (cap: number) => new Error(`"${attachment.name as string}" is over ${bytesLabel(cap)}, too big to attach.`);
    if ('path' in attachment) {
      const size = await fileSize(attachment.path);
      if (size === undefined) throw new Error(`"${attachment.name}" is not a file to attach.`);
      if (size > MAX_ATTACHMENT_BYTES) throw tooBig(MAX_ATTACHMENT_BYTES);
      total += size;
    } else if (attachment.data instanceof Uint8Array) {
      if (attachment.data.byteLength > MAX_PASTED_ATTACHMENT_BYTES) throw tooBig(MAX_PASTED_ATTACHMENT_BYTES);
      total += attachment.data.byteLength;
    } else {
      throw new Error(`"${attachment.name}" has no content to attach.`);
    }
  }
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error(`A message's attachments can come to at most ${bytesLabel(MAX_MESSAGE_ATTACHMENT_BYTES)}.`);
  return attachments as NewAttachment[];
}

/** The size of the regular file at an absolute path; undefined for anything else. */
async function fileSize(path: unknown): Promise<number | undefined> {
  if (typeof path !== 'string' || !isAbsolute(path)) return undefined;
  const found = await stat(path).catch(() => undefined);
  return found?.isFile() ? found.size : undefined;
}

/** A name that is a plain file name in any Environment: its last part, without characters Windows or the shell would trip on. */
function fileName(name: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? '';
  // eslint-disable-next-line no-control-regex
  return last.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
}

/** The file's extension, with its dot, lower-cased; empty if it has none Loom would keep. */
function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? `.${match[1]!.toLowerCase()}` : '';
}

/** The media type the renderer gave, if it looks like one, or else the one its extension says. */
function mimeTypeOf(name: string, given: string | undefined): string {
  if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given)) return given.toLowerCase();
  return MIME_TYPES[extensionOf(name).slice(1)] ?? 'application/octet-stream';
}
