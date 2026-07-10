import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(
  readFileSync("src-tauri/tauri.conf.json", "utf8"),
);
const cargoMetadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--no-deps",
      "--format-version",
      "1",
    ],
    { encoding: "utf8" },
  ),
);
const cargoPackage = cargoMetadata.packages.find(
  (item) => item.name === "orbit-browser",
);

if (!cargoPackage) {
  throw new Error("Could not find orbit-browser in Cargo metadata");
}

const versions = new Map([
  ["package.json", packageJson.version],
  ["src-tauri/Cargo.toml", cargoPackage.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
]);
const uniqueVersions = new Set(versions.values());

if (uniqueVersions.size !== 1) {
  throw new Error(
    `Version mismatch: ${Array.from(versions, ([file, version]) => `${file}=${version}`).join(", ")}`,
  );
}

const version = packageJson.version;
const releaseTag = process.env.GITHUB_REF_TYPE === "tag"
  ? process.env.GITHUB_REF_NAME
  : undefined;

if (releaseTag && releaseTag !== `v${version}`) {
  throw new Error(
    `Release tag ${releaseTag} does not match application version v${version}`,
  );
}

console.log(`Version ${version} is consistent across application manifests.`);
