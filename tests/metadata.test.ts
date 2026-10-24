import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { commandProfiles } from "../shared/music";

const root = resolve(import.meta.dirname, "..");
const paths = new Set(["package.json"]);
function include(path: string) {
  const absolute = join(root, path), stat = lstatSync(absolute);
  assert.equal(stat.isSymbolicLink(), false, `Package entry must not import an external symlink: ${path}`);
  if (stat.isDirectory()) for (const child of readdirSync(absolute)) include(join(path, child));
  else paths.add(path.split(sep).join("/"));
}
for (const path of JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files as string[]) include(path.replace(/\/$/, ""));

test("every relative documentation link ships in the declared package", () => {
  const manifest = JSON.parse(readFileSync(join(root, "paseo-plugin.json"), "utf8"));
  assert.equal(manifest.id, "paseo-music", "Renaming the studio must preserve installation/settings identity");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.description, manifest.description, "Public descriptions must agree");
  assert.equal(pkg.name, lock.name); assert.equal(pkg.version, lock.version);
  assert.equal(pkg.version, lock.packages[""].version, "Lock metadata must match the release");
  assert(readFileSync(join(root, "README.md"), "utf8").includes(`\`${manifest.requirements.paseo}\``), "README compatibility must match the manifest");
  for (const media of manifest.media as string[]) assert(paths.has(media), `Missing listing media: ${media}`);
  for (const path of paths) {
    if (!path.endsWith(".md")) continue;
    const text = readFileSync(join(root, path), "utf8");
    assert.equal(text.split("```").length % 2, 1, `Unbalanced code fences in ${path}`);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:|^#/i.test(match[1])) continue;
      const target = relative(root, resolve(root, dirname(path), match[1].split("#")[0])).split(sep).join("/");
      assert(paths.has(target), `${path} links to a file missing from the distribution: ${target}`);
    }
  }
  assert.equal(paths.has("PROGRESS.md"), false, "Private development notes must not ship");
  assert.equal(paths.has("PLAN.md"), false, "Private development plans must not ship");
});

test("example command profiles can be pasted directly into Settings", () => {
  for (const name of ["command-profile.json", "minimax-profile.json"]) {
    const profiles = commandProfiles.parse(JSON.parse(readFileSync(join(root, "examples", name), "utf8")));
    assert(profiles.length > 0, `${name} must contain a usable profile`);
  }
});

test("documented VM runner entry points remain directly executable", { skip: process.platform === "win32" }, () => {
  const runners = readdirSync(join(root, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => `tests/${entry.name}/run.sh`)
    .filter((path) => existsSync(join(root, path)));
  for (const path of runners) {
    assert(statSync(join(root, path)).mode & 0o111, `${path} needs its executable Git file mode`);
    assert(readFileSync(join(root, path), "utf8").startsWith("#!/usr/bin/env bash\n"), path);
  }
});
