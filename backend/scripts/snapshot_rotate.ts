// scripts/snapshot-rotate.ts
// Rotate and manage backtester snapshots (e.g. daily PnL runs, portfolios, or reports).
// Keeps N most recent snapshots in a folder, deletes older ones.
// Usage:
//   npx ts-node scripts/snapshot-rotate.ts --dir=./snapshots --keep=10

import * as fs from "fs";
import * as path from "path";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v ?? true;
    }
  }
  return flags;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✔ Created directory: ${dir}`);
  }
}

function snapshotName(): string {
  const now = new Date();
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `snapshot-${iso}.json`;
}

function writeSnapshot(dir: string, data: any) {
  const file = path.join(dir, snapshotName());
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`✔ Wrote snapshot: ${file}`);
}

function rotate(dir: string, keep: number) {
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith("snapshot-"))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.t - a.t);

  if (files.length <= keep) return;

  for (const old of files.slice(keep)) {
    fs.unlinkSync(path.join(dir, old.f));
    console.log(`✘ Deleted old snapshot: ${old.f}`);
  }
}

async function main() {
  const flags = parseArgs(process.argv);
  const dir = (flags.dir as string) || "./snapshots";
  const keep = parseInt((flags.keep as string) || "10", 10);

  ensureDir(dir);

  // Demo snapshot payload — replace with real state (PnL, portfolio, etc.)
  const demoPayload = {
    ts: new Date().toISOString(),
    portfolioValue: 100000 + Math.floor(Math.random() * 1000),
    positions: {
      "AAPL": { qty: 100, price: 172.5 },
      "MSFT": { qty: -50, price: 300.1 }
    }
  };

  writeSnapshot(dir, demoPayload);
  rotate(dir, keep);

  console.log(`✔ Rotation complete. Kept most recent ${keep} snapshots.`);
}

main().catch(err => {
  console.error("Snapshot rotation failed:", err);
  process.exit(1);
});