// Each Session's Panels as the user left them (ADR 0009): which are open in
// each Panel area, the one shown and whether each area is shown, kept in the
// database. Its Terminals' Panels don't come back after a restart, as the
// Terminals end when Loom quits.
import { checkSessionPanels, DEFAULT_SESSION_PANELS, withoutTerminals, type SessionPanels } from '../../shared/panels';
import type { LoomDatabase } from '../storage/database';

export class Panels {
  private listeners = new Map<number, Set<(panels: SessionPanels) => void>>();

  private constructor(
    private readonly db: LoomDatabase,
    private readonly states: Map<number, SessionPanels>,
  ) {}

  /** What the database holds, the Terminals gone; a state Loom can no longer read is dropped for the default. */
  static async load(db: LoomDatabase): Promise<Panels> {
    const rows = await db.selectFrom('session_panels').selectAll().execute();
    const states = new Map<number, SessionPanels>();
    for (const row of rows) {
      try {
        states.set(row.session_id, withoutTerminals(checkSessionPanels(JSON.parse(row.state))));
      } catch (error) {
        console.error(`dropping Session ${row.session_id}'s Panels, which Loom can't read:`, error);
      }
    }
    return new Panels(db, states);
  }

  /** Session `sessionId`'s Panels: as left, or a new Session's. */
  of(sessionId: number): SessionPanels {
    return this.states.get(sessionId) ?? DEFAULT_SESSION_PANELS;
  }

  /** Gives `listener` the Session's Panels now, then each change. */
  subscribe(sessionId: number, listener: (panels: SessionPanels) => void): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) this.listeners.set(sessionId, (listeners = new Set()));
    listeners.add(listener);
    listener(this.of(sessionId));
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  /** Keeps the Session's Panels. Rejects Panels Loom has not, one open twice, or a Session that isn't there. */
  async set(sessionId: number, panels: SessionPanels): Promise<void> {
    const checked = checkSessionPanels(panels);
    const state = JSON.stringify(checked);
    await this.db
      .insertInto('session_panels')
      .values({ session_id: sessionId, state })
      .onConflict((c) => c.column('session_id').doUpdateSet({ state }))
      .execute();
    this.states.set(sessionId, checked);
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener(checked);
  }
}
