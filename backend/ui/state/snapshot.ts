/* state/snapshots.ts */
/* Immutable snapshot manager for time-travel, undo/redo, and audit trails */
/* Framework-agnostic, zero dependencies */

export type Snapshot<T> = {
  id: string;
  timestamp: number;
  label?: string;
  state: T;
};

class SnapshotStore<T> {
  private snapshots: Snapshot<T>[] = [];
  private pointer = -1;
  private maxSnapshots = 100;

  constructor(maxSnapshots?: number) {
    if (maxSnapshots && maxSnapshots > 0) {
      this.maxSnapshots = maxSnapshots;
    }
  }

  capture(state: T, label?: string): Snapshot<T> {
    const snapshot: Snapshot<T> = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      label,
      state: deepClone(state),
    };

    // Drop future snapshots if we branched
    if (this.pointer < this.snapshots.length - 1) {
      this.snapshots = this.snapshots.slice(0, this.pointer + 1);
    }

    this.snapshots.push(snapshot);

    // Enforce cap
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    } else {
      this.pointer++;
    }

    return snapshot;
  }

  undo(): Snapshot<T> | null {
    if (this.pointer <= 0) return null;
    this.pointer--;
    return this.snapshots[this.pointer];
  }

  redo(): Snapshot<T> | null {
    if (this.pointer >= this.snapshots.length - 1) return null;
    this.pointer++;
    return this.snapshots[this.pointer];
  }

  current(): Snapshot<T> | null {
    if (this.pointer < 0) return null;
    return this.snapshots[this.pointer];
  }

  all(): Snapshot<T>[] {
    return [...this.snapshots];
  }

  clear() {
    this.snapshots = [];
    this.pointer = -1;
  }
}

/* Factory helper */

export function createSnapshotStore<T>(maxSnapshots?: number) {
  return new SnapshotStore<T>(maxSnapshots);
}

/* Utilities */

function deepClone<T>(value: T): T {
  return structuredClone
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}