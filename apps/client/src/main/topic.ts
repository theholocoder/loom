/** A value main publishes to subscribers: each one gets the current value, then every change. */
export class Topic<T> {
  private listeners = new Set<(value: T) => void>();

  constructor(private current: T) {}

  get value(): T {
    return this.current;
  }

  set(value: T): void {
    this.current = value;
    for (const listener of [...this.listeners]) listener(value);
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
}
