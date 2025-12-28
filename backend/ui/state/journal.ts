/* ui/state/journal.ts */
/* Lightweight, framework-agnostic state container for journaling / logs */
/* No React, no external dependencies */

export type JournalEntry = {
  id: string;
  timestamp: number;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type JournalSubscriber = (entries: JournalEntry[]) => void;

class JournalStore {
  private entries: JournalEntry[] = [];
  private subscribers: Set<JournalSubscriber> = new Set();
  private maxEntries = 500;

  add(entry: Omit<JournalEntry, "id" | "timestamp">) {
    const fullEntry: JournalEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry,
    };

    this.entries.push(fullEntry);

    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    this.notify();
  }

  getAll(): JournalEntry[] {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    this.notify();
  }

  subscribe(fn: JournalSubscriber): () => void {
    this.subscribers.add(fn);
    fn(this.getAll());

    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify() {
    const snapshot = this.getAll();
    this.subscribers.forEach((fn) => fn(snapshot));
  }
}

export const journal = new JournalStore();

/* Convenience helpers */

export function logInfo(
  source: string,
  message: string,
  metadata?: Record<string, unknown>
) {
  journal.add({ level: "info", source, message, metadata });
}

export function logWarn(
  source: string,
  message: string,
  metadata?: Record<string, unknown>
) {
  journal.add({ level: "warn", source, message, metadata });
}

export function logError(
  source: string,
  message: string,
  metadata?: Record<string, unknown>
) {
  journal.add({ level: "error", source, message, metadata });
}