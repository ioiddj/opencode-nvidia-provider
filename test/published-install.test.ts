import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  findInstalledPackages,
  inspectPackageLayout,
  loadTargetsPackage,
  parsePluginLoads,
  parsePluginSpecs,
} from "../scripts/runtime/published-install.ts"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const scratchRoot = join(repositoryRoot, ".runtime-state", "test-published-install")

const LOG_LINE =
  'timestamp=2026-10-26T02:00:00.000Z level=INFO msg="loading plugin" ' +
  "id=/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868 " +
  "entrypoint=file:///state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868/index.ts " +
  "role=server"

test("reads the plugin specifiers out of a global configuration", () => {
  const specs = parsePluginSpecs({
    plugins: ["github:ioiddj/opencode-nvidia-provider", 42, null],
  })

  assert.deepEqual(specs, ["github:ioiddj/opencode-nvidia-provider"])
})

test("reports no specifiers for a configuration without plugins", () => {
  assert.deepEqual(parsePluginSpecs({}), [])
  assert.deepEqual(parsePluginSpecs({ plugins: "github:ioiddj/opencode-nvidia-provider" }), [])
  assert.deepEqual(parsePluginSpecs(undefined), [])
  assert.deepEqual(parsePluginSpecs(null), [])
})

test("reads a plugin load with its entrypoint", () => {
  const loads = parsePluginLoads(LOG_LINE)

  assert.equal(loads.length, 1)
  assert.equal(
    loads[0]?.entrypoint,
    "/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868/index.ts",
  )
  assert.equal(
    loads[0]?.id,
    "/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868",
  )
})

test("ignores log lines that do not report a plugin load", () => {
  const log = [
    'timestamp=... msg="watcher started" path=/home/user/.opencode type=directory',
    'timestamp=... msg="loading plugin" id=/somewhere/other',
  ].join("\n")

  assert.deepEqual(parsePluginLoads(log), [])
})

test("accepts a load whose entrypoint is inside the installed package", () => {
  const packageDir = "/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868"
  const load = parsePluginLoads(LOG_LINE)[0]

  assert.ok(load !== undefined)
  assert.equal(loadTargetsPackage(load, packageDir), true)
})

test("rejects a load of a different plugin that only looks similar", () => {
  const packageDir = "/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868"
  const load = {
    id: "/elsewhere",
    entrypoint: "/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123-elsewhere/index.ts",
  }

  assert.equal(loadTargetsPackage(load, packageDir), false)
})

test("rejects a load whose entrypoint is the package directory itself", () => {
  const packageDir = "/state/cache/opencode/npm/git-opencode-nvidia-provider-abc123/1792989708868"
  const load = { id: packageDir, entrypoint: packageDir }

  assert.equal(loadTargetsPackage(load, packageDir), false)
})

test("lists the installed files and reports dependency directories", async () => {
  const packageDir = join(scratchRoot, "package")
  await rm(scratchRoot, { recursive: true, force: true })
  await mkdir(join(packageDir, "src"), { recursive: true })
  await mkdir(join(packageDir, "node_modules", "left-pad"), { recursive: true })
  await writeFile(join(packageDir, "index.ts"), "export default {}\n", "utf8")
  await writeFile(join(packageDir, "src", "retry-policy.ts"), "export {}\n", "utf8")
  await writeFile(join(packageDir, "node_modules", "left-pad", "index.js"), "module.exports = 1\n", "utf8")

  const layout = await inspectPackageLayout(packageDir)

  assert.deepEqual(layout.files, ["index.ts", "src/retry-policy.ts"])
  assert.deepEqual(layout.dependencyDirectories, ["node_modules"])

  await rm(scratchRoot, { recursive: true, force: true })
})

test("finds an installed package by its entrypoint and sources", async () => {
  const cacheRoot = join(scratchRoot, "cache", "opencode", "npm")
  const packageDir = join(cacheRoot, "git-opencode-nvidia-provider-abc123", "1792989708868")
  const incompleteDir = join(cacheRoot, "git-other-plugin-def456", "1792989708868")

  await rm(scratchRoot, { recursive: true, force: true })
  await mkdir(join(packageDir, "src"), { recursive: true })
  await mkdir(incompleteDir, { recursive: true })
  await writeFile(join(packageDir, "index.ts"), "export default {}\n", "utf8")
  await writeFile(join(incompleteDir, "index.ts"), "export default {}\n", "utf8")

  const packages = await findInstalledPackages(join(scratchRoot, "cache", "opencode"))

  assert.deepEqual(packages, [packageDir])

  await rm(scratchRoot, { recursive: true, force: true })
})
