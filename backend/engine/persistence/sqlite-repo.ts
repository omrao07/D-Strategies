// persistence/sqlite-repo.ts

type Entity = {
  id: string
  [key: string]: any
}

interface Repo<T extends Entity> {
  all(): T[]
  get(id: string): T | undefined
  save(entity: T): void
  delete(id: string): boolean
}

class SqliteRepo<T extends Entity> implements Repo<T> {
  private db: any
  private table: string
  private stmts: {
    upsert?: any
    selectOne?: any
    selectAll?: any
    deleteOne?: any
  } = {}

  constructor(filePath: string, table: string = "entities") {
    // Prefer better-sqlite3 (sync) for simplicity
    let BetterSqlite3: any
    try {
      BetterSqlite3 = (require as any)("better-sqlite3")
    } catch (e) {
      throw new Error(
        "better-sqlite3 is required at runtime. Please add it to your dependencies."
      )
    }

    this.db = new BetterSqlite3(filePath)
    this.table = table
    this.ensureTable()
    this.prepareStatements()
  }

  private ensureTable(): void {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.escapeIdent(this.table)} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.escapeIdent(this.table + "_updated_at_idx")}
        ON ${this.escapeIdent(this.table)} (updated_at);
    `
    this.db.exec(sql)
  }

  private prepareStatements(): void {
    this.stmts.upsert = this.db.prepare(
      `INSERT INTO ${this.escapeIdent(this.table)} (id, data, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         data=excluded.data,
         updated_at=excluded.updated_at`
    )
    this.stmts.selectOne = this.db.prepare(
      `SELECT data FROM ${this.escapeIdent(this.table)} WHERE id = ?`
    )
    this.stmts.selectAll = this.db.prepare(
      `SELECT data FROM ${this.escapeIdent(this.table)}`
    )
    this.stmts.deleteOne = this.db.prepare(
      `DELETE FROM ${this.escapeIdent(this.table)} WHERE id = ?`
    )
  }

  private escapeIdent(name: string): string {
    // Very lightweight identifier escaping using double quotes
    // Replace any embedded quotes with doubled quotes
    return `"${String(name).replace(/"/g, '""')}"`
  }

  all(): T[] {
    const rows = this.stmts.selectAll.all()
    if (!rows || rows.length === 0) return []
    return rows.map((r: any) => {
      try {
        return JSON.parse(r.data) as T
      } catch {
        return undefined
      }
    }).filter(Boolean) as T[]
  }

  get(id: string): T | undefined {
    const row = this.stmts.selectOne.get(id)
    if (!row) return undefined
    try {
      return JSON.parse(row.data) as T
    } catch {
      return undefined
    }
  }

  save(entity: T): void {
    if (!entity || typeof entity.id !== "string" || entity.id.length === 0) {
      throw new Error("Entity must have a non-empty string id")
    }
    const payload = JSON.stringify(entity)
    const now = Date.now()
    this.stmts.upsert.run(entity.id, payload, now)
  }

  delete(id: string): boolean {
    const res = this.stmts.deleteOne.run(id)
    // better-sqlite3 returns changes count
    return typeof res?.changes === "number" ? res.changes > 0 : false
  }

  close(): void {
    if (this.db) this.db.close()
  }
}

export { SqliteRepo, Repo, Entity }
// pipelines/single.ts
