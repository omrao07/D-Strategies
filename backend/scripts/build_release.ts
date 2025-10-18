// scripts/build-release.ts
// Simple release script: bumps version, builds project, and tags git release.
// Usage:
//   npx ts-node scripts/build-release.ts --version=0.2.0

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): Flags {
  const out: Flags = {};
  for (const tok of argv.slice(2)) {
    if (tok.startsWith("--")) {
      const [k, v] = tok.slice(2).split("=");
      out[k] = v ?? true;
    }
  }
  return out;
}

function updatePackageJson(newVersion: string) {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = newVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`✔ package.json version set to ${newVersion}`);
}

function updateChangelog(newVersion: string) {
  const changelogPath = path.resolve(process.cwd(), "docs/changelog.md");
  if (!fs.existsSync(changelogPath)) return;

  let text = fs.readFileSync(changelogPath, "utf8");
  const unreleasedHeader = "## [Unreleased]";
  const newHeader = `## [${newVersion}] - ${new Date().toISOString().slice(0, 10)}`;

  if (text.includes(unreleasedHeader)) {
    text = text.replace(unreleasedHeader, `${unreleasedHeader}\n\n${newHeader}`);
  } else {
    text = `${text.trim()}\n\n${newHeader}\n- Version bump.\n`;
  }

  fs.writeFileSync(changelogPath, text);
  console.log(`✔ docs/changelog.md updated with ${newVersion}`);
}

function run(cmd: string) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function main() {
  const flags = parseArgs(process.argv);
  const newVersion = (flags.version as string) || "";
  if (!newVersion) {
    console.error("Error: --version=x.y.z required");
    process.exit(1);
  }

  // Step 1: Update files
  updatePackageJson(newVersion);
  updateChangelog(newVersion);

  // Step 2: Build
  run("tsc -p tsconfig.json");

  // Step 3: Git commit + tag
  run("git add package.json docs/changelog.md");
  run(`git commit -m "chore(release): v${newVersion}"`);
  run(`git tag v${newVersion}`);

  console.log(`\n✔ Release ${newVersion} prepared. Push with:`);
  console.log("  git push && git push --tags");
}

main().catch(err => {
  console.error("Release build failed:", err);
  process.exit(1);
});