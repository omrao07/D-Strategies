// scripts/gen-manifest.js
// Generate strategies/manifest.json automatically
// Run: node scripts/gen-manifest.js

import fs from "fs";
import path from "path";

const STRATEGIES_DIR = path.resolve("strategies");
const OUT_FILE = path.resolve(STRATEGIES_DIR, "manifest.json");

/** Recursively walk a directory and return all .js/.ts files */
function walkDir(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkDir(full, fileList);
    } else if (/\.(js|ts)$/i.test(f)) {
      fileList.push(full);
    }
  }
  return fileList;
}

/** Turn file path into manifest entry */
function toManifestEntry(filePath) {
  const relPath = path.relative(STRATEGIES_DIR, filePath).replace(/\\/g, "/");
  const base = path.basename(filePath, path.extname(filePath));
  const name = base.replace(/[_\-]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  // optional: infer tags from folder names
  const tags = path.dirname(relPath).split("/").filter(Boolean);
  return { name, path: `./${relPath}`, tags };
}

/** Main */
function main() {
  if (!fs.existsSync(STRATEGIES_DIR)) {
    console.error(`Strategies directory not found: ${STRATEGIES_DIR}`);
    process.exit(1);
  }

  const files = walkDir(STRATEGIES_DIR);
  const manifest = files.map(toManifestEntry);

  fs.writeFileSync(OUT_FILE, JSON.stringify({ strategies: manifest }, null, 2));
  console.log(`✅ Manifest written to ${OUT_FILE} with ${manifest.length} strategies`);
}

main();