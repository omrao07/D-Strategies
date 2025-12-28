/**
 * State Snapshots
 * ---------------
 *
 * Lightweight snapshot manager for:
 * - Portfolio state
 * - Strategy state
 * - Risk state
 * - Engine state
 *
 * No side effects. No I/O. No globals.
 */

export type SnapshotId = string;

export type Snapshot<T = unknown> = {
  id: SnapshotId;
  ts: number;            // unix epoch ms
  source: string;        // component name
  payload: T;            // arbitrary state
};

export type SnapshotMeta = {
  count: number;
  latest?: SnapshotId;
};

/**
 * In-memory snapshot store
 */
export class SnapshotStore<T = unknown> {
  private store: Map<SnapshotId, Snapshot<T>> = new Map();
  private order: SnapshotId[] = [];

  constructor(private readonly maxSize: number = 1000) { }

  // ─────────────────────────────────────────────────────────
  // Create
  // ─────────────────────────────────────────────────────────

  create(source: string, payload: T): Snapshot<T> {
    const snap: Snapshot<T> = {
      id: this.genId(source),
      ts: Date.now(),
      source,
      payload,
    };

    this.store.set(snap.id, snap);
    this.order.push(snap.id);

    this.evictIfNeeded();
    return snap;
  }

  // ─────────────────────────────────────────────────────────
  // Read
  // ─────────────────────────────────────────────────────────

  get(id: SnapshotId): Snapshot<T> | undefined {
    return this.store.get(id);
  }

  latest(): Snapshot<T> | undefined {
    const id = this.order[this.order.length - 1];
    return id ? this.store.get(id) : undefined;
  }

  list(): Snapshot<T>[] {
    return this.order.map(id => this.store.get(id)!).filter(Boolean);
  }

  // ─────────────────────────────────────────────────────────
  // Delete
  // ─────────────────────────────────────────────────────────

  clear(): void {
    this.store.clear();
    this.order = [];
  }

  // ─────────────────────────────────────────────────────────
  // Metadata
  // ─────────────────────────────────────────────────────────

  meta(): SnapshotMeta {
    return {
      count: this.order.length,
      latest: this.order[this.order.length - 1],
    };
  }

  // ─────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    while (this.order.length > this.maxSize) {
      const id = this.order.shift();
      if (id) this.store.delete(id);
    }
  }

  private genId(source: string): SnapshotId {
    return `${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Utility: deep-freeze snapshot payload (optional safety)
 */
export function freezeSnapshot<T>(snap: Snapshot<T>): Snapshot<Readonly<T>> {
  return {
    ...snap,
    payload: deepFreeze(snap.payload),
  };
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const key of Object.keys(obj as any)) {
      deepFreeze((obj as any)[key]);
    }
  }
  return obj;
}