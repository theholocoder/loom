// Updates: Loom looks for a newer stable release at startup and every 4
// hours, and downloads it in the background. It installs on the next quit,
// or when the user clicks "Restart to update": never on its own, so running
// agents are never stopped by an update.
import type { UpdateStatus } from '../shared/api';
import type { Clock, TimerHandle } from './clock';
import { Topic } from './topic';

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** What looks for, downloads and installs releases: electron-updater, or a test's stand-in. */
export interface Updater {
  /** Looks for a newer stable release and downloads it: resolves with its version once downloaded, or null when there is none. */
  checkAndDownload(): Promise<string | null>;
  /** Quits Loom (asking first if Sessions are Working), installs the downloaded update and starts Loom again. */
  quitAndInstall(): Promise<void>;
}

export class Updates {
  readonly status = new Topic<UpdateStatus>({ state: 'none' });
  private checking = false;
  private timer: TimerHandle | undefined;
  private stopped = false;

  /** With no updater, as in development, there is never an update. */
  constructor(
    private readonly updater: Updater | undefined,
    private readonly clock: Clock,
  ) {}

  /** Checks now, then every UPDATE_CHECK_INTERVAL_MS. */
  start(): void {
    if (!this.updater || this.stopped) return;
    this.check();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
  }

  /** Installs the update downloaded, restarting Loom. */
  async restart(): Promise<void> {
    if (!this.updater || this.status.value.state !== 'ready') throw new Error('There is no update downloaded to install.');
    await this.updater.quitAndInstall();
  }

  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      if (this.stopped) return;
      this.check();
      this.schedule();
    }, UPDATE_CHECK_INTERVAL_MS);
  }

  private check(): void {
    // A slow download is still the latest check: the next one waits for it.
    if (this.checking || !this.updater) return;
    this.checking = true;
    this.updater.checkAndDownload().then(
      (version) => {
        this.checking = false;
        if (version && !this.stopped) this.status.set({ state: 'ready', version });
      },
      (error: unknown) => {
        this.checking = false;
        // Offline, or GitHub unreachable: tried again at the next check.
        console.warn('Loom could not check for updates:', error instanceof Error ? error.message : error);
      },
    );
  }
}
