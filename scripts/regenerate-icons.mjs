#!/usr/bin/env node
/**
 * Regenerate platform icons for Orbit Browser.
 *
 * macOS Dock / Launchpad render app icons inside a rounded mask with
 * expected transparent padding. Full-bleed icons look larger than peers.
 * This script:
 *   1. Pads a full-bleed square master (~10% margin each side)
 *   2. Runs `pnpm tauri icon` to regenerate icns/ico/png sizes
 *   3. Syncs legacy 256x256.png if present
 *   4. Regenerates installer artwork that embeds the app icon
 *
 * Usage:
 *   node scripts/regenerate-icons.mjs [fullbleed-master.png]
 * Default master: src-tauri/icons/app-icon-fullbleed.png
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const masterPath = path.resolve(
  root,
  process.argv[2] || "src-tauri/icons/app-icon-fullbleed.png",
);
const paddedPath = path.join(root, "src-tauri/icons/app-icon-source.png");
const marginRatio = 0.1;

if (!fs.existsSync(masterPath)) {
  console.error(`Master icon not found: ${masterPath}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const padPy = `
from PIL import Image
from pathlib import Path

src = Image.open(${JSON.stringify(masterPath)}).convert("RGBA")
size = 1024
content = int(round(size * (1 - 2 * ${marginRatio})))
scaled = src.resize((content, content), Image.Resampling.LANCZOS)
canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
offset = (size - content) // 2
canvas.paste(scaled, (offset, offset), scaled)
out = Path(${JSON.stringify(paddedPath)})
out.parent.mkdir(parents=True, exist_ok=True)
canvas.save(out, "PNG")
print(f"padded icon -> {out} ({size}x{size}, content={content}, margin={${marginRatio}*100:.0f}%)")
`;
run("python3", ["-c", padPy]);
run("pnpm", ["tauri", "icon", "src-tauri/icons/app-icon-source.png"]);

const syncPy = `
from PIL import Image
from pathlib import Path
src = Image.open(${JSON.stringify(path.join(root, "src-tauri/icons/icon.png"))}).convert("RGBA")
legacy = Path(${JSON.stringify(path.join(root, "src-tauri/icons/256x256.png"))})
if legacy.exists():
    src.resize((256, 256), Image.Resampling.LANCZOS).save(legacy)
    print(f"updated {legacy}")
`;
run("python3", ["-c", syncPy]);
run("swift", ["scripts/generate-installer-assets.swift"]);
console.log("Icon regeneration complete.");
