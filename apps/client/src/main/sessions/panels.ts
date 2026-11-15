// Each Session's Panels as the user left them (ADR 0009): which are open in
// each Panel area, the one shown and whether each area is shown, kept in the
// database. Main is the one place that applies the Layout to them: each Panel
// is served, and kept, in the area and stack its kind sits in, and a
// Terminal's Panel goes once it ends. Terminals don't come back after a
// restart, as they end when Loom quits.
import { checkSessionPanels, DEFAULT_SESSION_PANELS, sameSessionPanels, servedPanels, withoutTerminals, type LayoutSettings, type SessionPanels } from '../../shared/panels';
import type { LoomDatabase } from '../storage/database';

export interface PanelsOptions {
  /** The Layout as settings have it now. */
  layout(): LayoutSettings;
  /** Whether Terminal `id` has ended; one that never ran hasn't. */
  ended(id: number): boolean;
}

export class Panels {
  private listeners = new Map<number, Set<(panels: SessionPanels) => void>>();
  /** What each Session's listeners were last given. */
  private published = new Map<number, SessionPanels>();

  private constructor(
    private readonly db: LoomDatabase,
    private readonly options: PanelsOptions,
    private readonly states: Map<number, SessionPanels>,
  ) {}

  /** What the database holds, the Terminals gone; a state Loom can no longer read is dropped for the default. */
  static async load(db: LoomDatabase, options: PanelsOptions): Promise<Panels> {
    const rows = await db.selectFrom('session_panels').selectAll().execute();
    const states = new Map<number, SessionPanels>();
    for (const row of rows) {
      try {
        states.set(row.session_id, withoutTerminals(checkSessionPanels(JSON.parse(row.state))));
      } catch (error) {
        console.error(`dropping Session ${row.session_id}'s Panels, which Loom can't read:`, error);
      }
    }
    return new Panels(db, options, states);
  }

  /** Session `sessionId`'s Panels: as left, or a new Session's, each where the Layout has its kind, without the Terminals that ended. */
  of(sessionId: number): SessionPanels {
    return this.applied(this.states.get(sessionId) ?? DEFAULT_SESSION_PANELS);
  }

  /** Gives `listener` the Session's Panels now, then each change. */
  subscribe(sessionId: number, listener: (panels: SessionPanels) => void): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) this.listeners.set(sessionId, (listeners = new Set()));
    listeners.add(listener);
    const panels = this.of(sessionId);
    this.published.set(sessionId, panels);
    listener(panels);
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      this.listeners.delete(sessionId);
      this.published.delete(sessionId);
    };
  }

  /**
   * Keeps the Session's Panels, each moved where the Layout has its kind and
   * those of Terminals that ended gone. Rejects Panels Loom has not, one open
   * twice, or a Session that isn't there.
   */
  async set(sessionId: number, panels: SessionPanels): Promise<void> {
    const kept = this.applied(checkSessionPanels(panels));
    const state = JSON.stringify(kept);
    await this.db
      .insertInto('session_panels')
      .values({ session_id: sessionId, state })
      .onConflict((c) => c.column('session_id').doUpdateSet({ state }))
      .execute();
    this.states.set(sessionId, kept);
    this.publish(sessionId);
  }

  /** Settings changed: the Layout may have, and with it where each Session's Panels sit. */
  settingsChanged(): void {
    for (const sessionId of [...this.listeners.keys()]) this.publish(sessionId);
  }

  /** The Session's Terminals changed: the Panel of one that ended goes. */
  terminalsChanged(sessionId: number): void {
    this.publish(sessionId);
  }

  private applied(panels: SessionPanels): SessionPanels {
    return servedPanels(panels, this.options.layout(), (id) => this.options.ended(id));
  }

  /** Gives the Session's listeners its Panels, when they changed from what they were last given. */
  private publish(sessionId: number): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    const panels = this.of(sessionId);
    const last = this.published.get(sessionId);
    if (last && sameSessionPanels(last, panels)) return;
    this.published.set(sessionId, panels);
    for (const listener of [...listeners]) listener(panels);
  }
}
