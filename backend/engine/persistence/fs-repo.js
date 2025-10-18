// engine/persistence/fs-repo.js
// Simple filesystem-backed repository for JSON objects.
// Works with NodeNext/ESM, no deps beyond Node stdlib.

import * as fs from "fs";
import * as path from "path";

/* ========= Helpers ========= */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeJSON(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/* ========= Repo Factory ========= */

export function FSRepo(baseDir) {
  ensureDir(baseDir);

  function fileFor(key) {
    return path.join(baseDir, `${key}.json`);
  }

  return {
    baseDir,

    save(key, obj) {
      writeJSON(fileFor(key), obj);
    },

    load(key, fallback = null) {
      return readJSON(fileFor(key), fallback);
    },

    exists(key) {
      return fs.existsSync(fileFor(key));
    },

    listKeys() {
      return fs
        .readdirSync(baseDir)
        .filter(f => f.endsWith(".json"))
        .map(f => f.replace(/\.json$/, ""));
    },

    delete(key) {
      const file = fileFor(key);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
  };
}

/* ========= Default Export ========= */

export default FSRepo;