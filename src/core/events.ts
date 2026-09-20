/** A dependency-free typed event emitter, so core never reaches for vscode.EventEmitter. */
export type Listener<T> = (payload: T) => void;

export interface Disposable {
  dispose(): void;
}

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(payload: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch (err) {
        // A misbehaving listener must not break the emitter or its siblings.
        console.error('[mcpilot] event listener threw', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
