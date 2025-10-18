// data/csv-feed.ts

type CSVRow = { [key: string]: string | number };

export class CSVFeed {
  private headers: string[] = [];
  private rows: CSVRow[] = [];

  constructor(csvText: string, delimiter: string = ",") {
    this.parse(csvText, delimiter);
  }

  private parse(csvText: string, delimiter: string): void {
    const lines = csvText.trim().split(/\r?\n/);

    if (lines.length === 0) return;

    // Extract headers
    this.headers = lines[0].split(delimiter).map(h => h.trim());

    // Extract rows
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(delimiter).map(v => v.trim());
      const row: CSVRow = {};
      this.headers.forEach((h, idx) => {
        const val = values[idx];
        const num = Number(val);
        row[h] = isNaN(num) || val === "" ? val : num;
      });
      this.rows.push(row);
    }
  }

  public getHeaders(): string[] {
    return [...this.headers];
  }

  public getRows(): CSVRow[] {
    return [...this.rows];
  }

  public getRow(index: number): CSVRow | undefined {
    return this.rows[index];
  }

  public filter(fn: (row: CSVRow, index: number) => boolean): CSVRow[] {
    return this.rows.filter(fn);
  }

  public map<T>(fn: (row: CSVRow, index: number) => T): T[] {
    return this.rows.map(fn);
  }

  public forEach(fn: (row: CSVRow, index: number) => void): void {
    this.rows.forEach(fn);
  }

  public size(): number {
    return this.rows.length;
  }
}
