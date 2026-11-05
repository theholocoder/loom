// Attachments: the files and images the user sends with a message. Main keeps
// them in the attachments folder in `userData`, one folder per Session, each
// file named by its content's hash; transcript events and queued messages
// refer to them. They reach the agent by being written into the Session's
// Environment through its bridge, where it reads them.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Attachment, type NewAttachment } from '../../shared/api';
import type { PromptFile } from '../agents/adapter';
import type { BridgeCall } from '../environments/exec';

/** The folder in `userData` attachments are kept in. */
export const ATTACHMENTS_FOLDER = 'attachments';

/** How long the bridge gets to write one attachment. */
const WRITE_TIMEOUT_MS = 30_000;

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

export class Attachments {
  /** `userDataDir` is where the attachments folder goes. */
  constructor(private readonly userDataDir: string) {}

  /**
   * Stores the files attached to a message of the Session `sessionId`, once
   * each: the same content attached again is the same file.
   */
  async store(sessionId: number, attachments: NewAttachment[]): Promise<Attachment[]> {
    const stored: Attachment[] = [];
    for (const attachment of attachments) {
      const data = attachment.data;
      const hash = createHash('sha256').update(data).digest('hex');
      const name = fileName(attachment.name);
      const kept: Attachment = { name, mimeType: mimeTypeOf(name, attachment.mimeType), size: data.byteLength, hash };
      const path = this.path(sessionId, kept);
      await mkdir(join(this.userDataDir, ATTACHMENTS_FOLDER, String(sessionId)), { recursive: true });
      // Written beside its place and renamed in, so a crash never leaves half a file under its hash.
      const partial = `${path}.partial`;
      await writeFile(partial, data);
      await rename(partial, path);
      stored.push(kept);
    }
    return stored;
  }

  /**
   * Writes the Session's attachments into its Environment, under
   * `<tempDir>/loom-attachments/<session>/<hash>/<name>`, where the agent works
   * freely, and says where they are. Written again each time, the temp
   * directory being anyone's to clear.
   */
  async deliver(sessionId: number, attachments: Attachment[], environment: { request: BridgeCall; tempDir: string }): Promise<PromptFile[]> {
    const files: PromptFile[] = [];
    for (const attachment of attachments) {
      const data = await readFile(this.path(sessionId, attachment));
      const path = `${environment.tempDir}/loom-attachments/${sessionId}/${attachment.hash}/${attachment.name}`;
      await environment.request('files.write', WRITE_TIMEOUT_MS, { path, data: data.toString('base64') });
      files.push({ path, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, data });
    }
    return files;
  }

  /** Removes every attachment of the Session. */
  async remove(sessionId: number): Promise<void> {
    await rm(join(this.userDataDir, ATTACHMENTS_FOLDER, String(sessionId)), { recursive: true, force: true });
  }

  private path(sessionId: number, { hash, name }: Pick<Attachment, 'hash' | 'name'>): string {
    return join(this.userDataDir, ATTACHMENTS_FOLDER, String(sessionId), `${hash}${extensionOf(name)}`);
  }
}

/**
 * Rejects what can't be attached: anything but a list of named files, more
 * than MAX_ATTACHMENTS of them, or one over MAX_ATTACHMENT_BYTES.
 */
export function checkAttachments(attachments: unknown): NewAttachment[] {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments)) throw new Error('Attachments come as a list of files.');
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
  for (const attachment of attachments as Array<Partial<NewAttachment> | null>) {
    if (typeof attachment?.name !== 'string' || !fileName(attachment.name)) throw new Error('An attachment needs a file name.');
    if (!(attachment.data instanceof Uint8Array)) throw new Error(`${attachment.name} has no content to attach.`);
    if (attachment.mimeType !== undefined && typeof attachment.mimeType !== 'string') throw new Error(`${attachment.name}'s media type must be text.`);
    if (attachment.data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${attachment.name} is over ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB, too big to attach.`);
    }
  }
  return attachments as NewAttachment[];
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
