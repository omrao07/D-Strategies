/* state/reconcile.ts */
/* Deterministic reconciliation engine for client/server or local/remote state */
/* Framework-agnostic, no external dependencies */

export type ReconcileAction<T> = {
  type: "add" | "update" | "remove";
  id: string;
  payload?: Partial<T>;
};

export type ReconcileResult<T> = {
  next: T[];
  added: T[];
  updated: T[];
  removed: T[];
};

type WithId = {
  id: string;
};

export function reconcile<T extends WithId>(
  current: T[],
  incoming: T[]
): ReconcileResult<T> {
  const currentMap = new Map<string, T>();
  const incomingMap = new Map<string, T>();

  current.forEach((item) => currentMap.set(item.id, item));
  incoming.forEach((item) => incomingMap.set(item.id, item));

  const added: T[] = [];
  const updated: T[] = [];
  const removed: T[] = [];

  // Added or updated
  incomingMap.forEach((nextItem, id) => {
    const prevItem = currentMap.get(id);

    if (!prevItem) {
      added.push(nextItem);
    } else if (!shallowEqual(prevItem, nextItem)) {
      updated.push(nextItem);
    }
  });

  // Removed
  currentMap.forEach((prevItem, id) => {
    if (!incomingMap.has(id)) {
      removed.push(prevItem);
    }
  });

  const next = [
    ...current.filter((item) => !removed.find((r) => r.id === item.id)),
    ...added,
    ...updated,
  ];

  return {
    next,
    added,
    updated,
    removed,
  };
}

/* Optional reducer-style helper */

export function applyActions<T extends WithId>(
  state: T[],
  actions: ReconcileAction<T>[]
): T[] {
  const map = new Map<string, T>(state.map((s) => [s.id, s]));

  for (const action of actions) {
    switch (action.type) {
      case "add":
        if (action.payload) {
          map.set(action.id, { id: action.id, ...action.payload } as T);
        }
        break;

      case "update": {
        const existing = map.get(action.id);
        if (existing && action.payload) {
          map.set(action.id, { ...existing, ...action.payload });
        }
        break;
      }

      case "remove":
        map.delete(action.id);
        break;
    }
  }

  return Array.from(map.values());
}

/* Utilities */

function shallowEqual(a: any, b: any): boolean {
  if (a === b) return true;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}