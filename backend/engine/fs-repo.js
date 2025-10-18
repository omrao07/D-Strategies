// engine/persistence/fs-repo.js
// Minimal filesystem persistence for strategy runs.
// Saves JSON results under outputs/runs/, lists & reads them.

import fs from "fs";
import path from "path";

/** Ensure directory exists */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Safe filename from id + timestamp */
function runFilename(id, ts = Date.now()) {
  const safe = String(id || "run").replace(/[^\w.-]+/g, "_");
  return `${safe}-${ts}.json`;
}

export class FSRepo {
  /**
   * @param {string} [dir] base directory to store runs
   */
  constructor(dir = path.resolve(process.cwd(), "outputs/runs")) {
    this.dir = dir;
    ensureDir(this.dir);
  }

  /** Save a run result object as JSON. Returns absolute file path. */
  async saveRun(result) {
    const ts = Date.now();
    const file = path.join(this.dir, runFilename(result?.id, ts));
    const pretty = JSON.stringify(result ?? {}, null, 2);
    fs.writeFileSync(file, pretty, "utf8");
    return file;
  }

  /** List run file names (sorted oldest→newest). */
  listFiles() {
    ensureDir(this.dir);
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  }

  /** Read and parse a specific run JSON by file name. */
  read(fileName) {
    const abs = path.join(this.dir, fileName);
    const txt = fs.readFileSync(abs, "utf8");
    return JSON.parse(txt);
  }

  /** List last N run objects (newest first). */
  async listRuns(limit = 20) {
    const files = this.listFiles().slice(-limit).reverse();
    return files.map((f) => this.read(f));
  }

  /** Return the most recent run object, or null if none. */
  getLatest() {
    const files = this.listFiles();
    if (!files.length) return null;
    return this.read(files[files.length - 1]);
  }

  /** Delete runs older than a given count, keeping the newest `keep` files. */
  cleanup(keep = 200) {
    const files = this.listFiles();
    const toDelete = files.slice(0, Math.max(0, files.length - keep));
    for (const f of toDelete) {
      fs.unlinkSync(path.join(this.dir, f));
    }
    return toDelete.length;
  }
}

export default { FSRepo };