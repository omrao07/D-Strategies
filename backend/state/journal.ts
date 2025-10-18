// state/journal.ts
// Immutable journal store for trades/cash/equity adjustments
// Provides helpers for balance snapshots and PnL over time

export type JournalEntry = {
  /** ISO date string (yyyy-mm-dd) */
  date: string;
  /** Unique identifier (optional, useful for deduplication) */
  id?: string;
  /** Free-form note */
  note?: string;
  /** Delta adjustments */
  cashDelta?: number;
  equityDelta?: number;
  [k: string]: any;
};

export class Journal {
  private entries: JournalEntry[] = [];

  constructor(initial?: JournalEntry[]) {
    if (initial) {
      this.entries = [...initial].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  /** Append a new journal entry (immutably returns new Journal). */
  add(entry: JournalEntry): Journal {
    return new Journal([...this.entries, entry]);
  }

  /** Get all entries (sorted by date). */
  all(): JournalEntry[] {
    return [...this.entries];
  }

  /** Filter entries before (strictly less than) a given day. */
  entriesBefore(dayISO: string): JournalEntry[] {
    return this.entries.filter((e) => e.date < dayISO);
  }

  /** Filter entries exactly on a day. */
  entriesOn(dayISO: string): JournalEntry[] {
    return this.entries.filter((e) => e.date === dayISO);
  }

  /** Compute cumulative cash up to (but not including) a day. */
  openingCash(dayISO: string): number {
    return round2(
      this.entriesBefore(dayISO).reduce((sum, e) => sum + (e.cashDelta ?? 0), 0)
    );
  }

  /** Compute cumulative equity up to (but not including) a day. */
  openingEquity(dayISO: string): number {
    return round2(
      this.entriesBefore(dayISO).reduce((sum, e) => sum + (e.equityDelta ?? 0), 0)
    );
  }

  /** Net cash on a specific day. */
  cashOn(dayISO: string): number {
    return round2(
      this.entriesOn(dayISO).reduce((sum, e) => sum + (e.cashDelta ?? 0), 0)
    );
  }

  /** Net equity on a specific day. */
  equityOn(dayISO: string): number {
    return round2(
      this.entriesOn(dayISO).reduce((sum, e) => sum + (e.equityDelta ?? 0), 0)
    );
  }

  /** Snapshot balances at start of day (opening) and net for day. */
  snapshot(dayISO: string) {
    return {
      openingCash: this.openingCash(dayISO),
      openingEquity: this.openingEquity(dayISO),
      dayCash: this.cashOn(dayISO),
      dayEquity: this.equityOn(dayISO),
    };
  }
}

/* ------------------------------- Helpers ------------------------------- */

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/* ------------------------------- Example ------------------------------- */
// const j = new Journal()
//   .add({ date: "2025-10-01", cashDelta: 1000 })
//   .add({ date: "2025-10-02", equityDelta: 500 })
//   .add({ date: "2025-10-02", cashDelta: -200 });
//
// console.log(j.snapshot("2025-10-02"));
// -> { openingCash: 1000, openingEquity: 0, dayCash: -200, dayEquity: 500 }
