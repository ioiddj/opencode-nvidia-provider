import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import test from "node:test"

import {
  assertFixtureInsideRepository,
  assertLoopbackEndpoint,
  assertSafeStateRoot,
  comparePluginIds,
  findOperatorHomeReferences,
  isLoopbackUrl,
  operatorConfigDirectories,
  parseLoadedPluginIds,
  parseRuntimeTimeout,
  redactServerSecrets,
  ServerOutput,
  stopChild,
} from "../scripts/runtime/smoke.ts"

const LOG_LINE =
  'timestamp=2026-10-26T01:21:43.229Z level=INFO run=02102775 msg="loading plugin" ' +
  "id=/home/user/projects/opencode-nvidia-provider/test/runtime/control " +
  "entrypoint=file:///home/user/projects/opencode-nvidia-provider/test/runtime/control/index.ts " +
  "http.span=171 role=server"

const REPOSITORY_ROOT = "/home/user/projects/opencode-nvidia-provider"

test("reads the loaded plugin ids out of the OpenCode debug log", () => {
  const ids = parseLoadedPluginIds(LOG_LINE)

  assert.deepEqual(ids, ["/home/user/projects/opencode-nvidia-provider/test/runtime/control"])
})

test("ignores log lines that do not report a plugin load", () => {
  const log = [
    'timestamp=... level=INFO msg="watcher started" path=/home/user/.opencode type=directory',
    'timestamp=... level=INFO msg="server listening on http://127.0.0.1:1234"',
  ].join("\n")

  assert.deepEqual(parseLoadedPluginIds(log), [])
})

test("detects operator plugins loaded from the real home", () => {
  // This is the leak the runtime gate exists to catch: OpenCode discovers
  // plugins in `.opencode/plugins` directories above the activated location.
  const log = [
    LOG_LINE,
    'timestamp=... msg="loading plugin" id=/home/user/.opencode/plugins/guard.ts entrypoint=file:///home/user/.opencode/plugins/guard.ts',
  ].join("\n")

  const ids = parseLoadedPluginIds(log)
  const comparison = comparePluginIds(ids, ["/home/user/projects/opencode-nvidia-provider/test/runtime/control"])

  assert.deepEqual(comparison.unexpected, ["/home/user/.opencode/plugins/guard.ts"])
  assert.deepEqual(comparison.missing, [])
})

test("reports the expected plugin as missing when it never loaded", () => {
  const comparison = comparePluginIds([], ["/expected/plugin"])

  assert.deepEqual(comparison.unexpected, [])
  assert.deepEqual(comparison.missing, ["/expected/plugin"])
})

test("flags operator configuration directories referenced by the log", () => {
  const log = [
    'timestamp=... msg="watcher subscribe" path=/home/user/.opencode type=directory',
    'timestamp=... msg="watcher subscribe" path=/home/user/.config/opencode/lib/camoufox.ts type=file',
  ].join("\n")

  assert.deepEqual(
    findOperatorHomeReferences(log, operatorConfigDirectories("/home/user")),
    [
      "/home/user/.opencode",
      "/home/user/.config/opencode",
    ],
  )
})

test("does not flag the isolated state directory as operator configuration", () => {
  const log = [
    'timestamp=... msg="watcher subscribe" path=/repo/.runtime-state/config/opencode type=directory',
    'timestamp=... msg="loading plugin" id=/repo/test/runtime entrypoint=file:///repo/test/runtime/index.ts',
  ].join("\n")

  assert.deepEqual(findOperatorHomeReferences(log, operatorConfigDirectories("/home/user")), [])
})

test("operator configuration directories cover the data directory too", () => {
  // OpenCode reads its data from `<XDG_DATA_HOME>/opencode`, which is not
  // necessarily under the home directory.
  const directories = operatorConfigDirectories("/home/user", {
    XDG_DATA_HOME: "/srv/opencode-data",
    XDG_CONFIG_HOME: "/srv/opencode-config",
  })

  assert.ok(directories.includes("/home/user/.opencode"))
  assert.ok(directories.includes("/home/user/.config/opencode"))
  assert.ok(directories.includes("/home/user/.local/share/opencode"))
  assert.ok(directories.includes("/srv/opencode-data/opencode"))
  assert.ok(directories.includes("/srv/opencode-config/opencode"))
})

test("operator configuration directories are empty without a home", () => {
  assert.deepEqual(operatorConfigDirectories(""), [])
})

test("a repo-local state directory is accepted", () => {
  assert.doesNotThrow(() =>
    assertSafeStateRoot(`${REPOSITORY_ROOT}/.runtime-state`, {
      repositoryRoot: REPOSITORY_ROOT,
      homeDirectory: "/home/user",
    }),
  )
})

test("the filesystem root is refused as a state directory", () => {
  assert.throws(
    () => assertSafeStateRoot("/", { repositoryRoot: REPOSITORY_ROOT, homeDirectory: "/home/user" }),
    /filesystem root/,
  )
})

test("a top-level directory is refused as a state directory", () => {
  assert.throws(
    () => assertSafeStateRoot("/tmp", { repositoryRoot: REPOSITORY_ROOT, homeDirectory: "/home/user" }),
    /top-level directory/,
  )
})

test("the home directory is refused as a state directory", () => {
  assert.throws(
    () => assertSafeStateRoot("/home/user", { repositoryRoot: REPOSITORY_ROOT, homeDirectory: "/home/user" }),
    /home directory/,
  )
})

test("an ancestor of the home directory is refused as a state directory", () => {
  assert.throws(
    () => assertSafeStateRoot("/home", { repositoryRoot: REPOSITORY_ROOT, homeDirectory: "/home/user" }),
    /contains the home directory/,
  )
})

test("the repository root is refused as a state directory", () => {
  // `rm -rf` on the repository root would delete the checkout, including .git.
  assert.throws(
    () => assertSafeStateRoot(REPOSITORY_ROOT, { repositoryRoot: REPOSITORY_ROOT }),
    /repository root/,
  )
})

test("a directory outside the repository is refused as a state directory", () => {
  // The operator's project tree is not the harness's to delete.
  assert.throws(
    () =>
      assertSafeStateRoot("/home/user/projects", {
        repositoryRoot: REPOSITORY_ROOT,
        homeDirectory: "/home/user",
      }),
    /not inside the repository root/,
  )
})

test("the current directory is refused as a state directory", () => {
  assert.throws(
    () => assertSafeStateRoot(".", { repositoryRoot: REPOSITORY_ROOT }),
    /not inside the repository root/,
  )
})

test("a fixture inside the repository is accepted", () => {
  assert.doesNotThrow(() =>
    assertFixtureInsideRepository(`${REPOSITORY_ROOT}/test/runtime`, REPOSITORY_ROOT),
  )
})

test("a relative fixture path is refused", () => {
  assert.throws(
    () => assertFixtureInsideRepository("test/runtime", REPOSITORY_ROOT),
    /must be absolute/,
  )
})

test("a fixture outside the repository is refused", () => {
  assert.throws(
    () => assertFixtureInsideRepository("/tmp/evil-plugin", REPOSITORY_ROOT),
    /outside the repository/,
  )
})

test("redacts every occurrence of the password", () => {
  const output = "server password s3cr3tCCC\nserver password s3cr3tCCC\n"

  const redacted = redactServerSecrets(output, "s3cr3tCCC")

  assert.equal(redacted.includes("s3cr3tCCC"), false)
  assert.equal(redacted.match(/\[redacted\]/g)?.length, 2)
})

test("redacts every password occurrence when the token is unknown", () => {
  // The password can arrive after the endpoint, so the pattern has to redact
  // every occurrence on its own, not only the first one.
  const output = "server password aaa111\nserver password bbb222\n"

  const redacted = redactServerSecrets(output, undefined)

  assert.equal(redacted.includes("aaa111"), false)
  assert.equal(redacted.includes("bbb222"), false)
})

test("redacts a password that arrives without the server prefix", () => {
  const redacted = redactServerSecrets("password=s3cr3tCCC\n", undefined)

  assert.equal(redacted.includes("s3cr3tCCC"), false)
})

test("redacts a password printed in a different case", () => {
  const redacted = redactServerSecrets("Server Password s3cr3tCCC\n", undefined)

  assert.equal(redacted.includes("s3cr3tCCC"), false)
})

test("redacts the base64 Basic credential the harness sends", () => {
  const secret = "s3cr3tCCC"
  const basic = Buffer.from(`opencode:${secret}`).toString("base64")

  const redacted = redactServerSecrets(`authorization=Basic ${basic}\n`, secret)

  assert.equal(redacted.includes(basic), false)
})

test("redacts any Basic credential, even when the password is unknown", () => {
  const basic = Buffer.from("opencode:unknown-secret").toString("base64")

  const redacted = redactServerSecrets(`authorization=Basic ${basic}\n`, undefined)

  assert.equal(redacted.includes(basic), false)
})

test("redacts the encoded credential even when it is not labelled Basic", () => {
  const secret = "s3cr3tCCC"
  const basic = Buffer.from(`opencode:${secret}`).toString("base64")

  const redacted = redactServerSecrets(`token=${basic}\n`, secret)

  assert.equal(redacted.includes(basic), false)
})

test("accepts only loopback addresses", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:4096"), true)
  assert.equal(isLoopbackUrl("http://localhost:4096"), true)
  assert.equal(isLoopbackUrl("http://[::1]:4096"), true)
  assert.equal(isLoopbackUrl("http://collector.example:8080/"), false)
  assert.equal(isLoopbackUrl("https://collector.example:8080/"), false)
  assert.equal(isLoopbackUrl("not a url"), false)
})

test("refuses to authenticate against a non-loopback address", () => {
  assert.doesNotThrow(() => assertLoopbackEndpoint("http://127.0.0.1:4096"))
  assert.throws(
    () => assertLoopbackEndpoint("http://collector.example:8080/"),
    /non-loopback/,
  )
})

test("the server output is parsed as it arrives", () => {
  const output = new ServerOutput()

  output.append("starting up\n")
  assert.equal(output.url, undefined)

  output.append("server listening on http://127.0.0.1:4096\n")
  assert.equal(output.url, "http://127.0.0.1:4096")

  // The password may arrive after the address.
  assert.equal(output.password, undefined)
  output.append("server password s3cr3tCCC\n")
  assert.equal(output.password, "s3cr3tCCC")
})

test("the server output capture stays bounded", () => {
  const output = new ServerOutput(512)

  for (let index = 0; index < 500; index += 1) {
    output.append(`line ${index} ${"x".repeat(64)}\n`)
  }

  assert.equal(output.truncated, true)
  assert.ok(output.text.length < 2_000, `retained ${output.text.length} characters`)
  assert.match(output.text, /earlier output truncated/)
})

test("the runtime timeout is bounded at both ends", () => {
  assert.equal(parseRuntimeTimeout(undefined), 30_000)
  assert.equal(parseRuntimeTimeout("5000"), 5_000)
  assert.throws(() => parseRuntimeTimeout("999"), /between 1000 and/)
  assert.throws(() => parseRuntimeTimeout("86400000"), /between 1000 and/)
  assert.throws(() => parseRuntimeTimeout("not-a-number"), /between 1000 and/)
})

test("stops a descendant that outlives the process group leader", async () => {
  // The server may fork a helper that ignores SIGTERM and then exit. The
  // helper stays in the process group, so the group has to be signalled even
  // after the leader is gone.
  const helper = `
    const { spawn } = require("node:child_process")
    const descendant = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    )
    process.stdout.write(String(descendant.pid) + "\\n")
    process.exit(0)
  `

  const child = spawn(process.execPath, ["-e", helper], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const descendantPid = await new Promise<number>((resolve, reject) => {
    let buffer = ""
    const timer = setTimeout(
      () => reject(new Error("the helper never reported its descendant")),
      10_000,
    )
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      const match = buffer.match(/\d+/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[0]))
      }
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  try {
    // The leader has exited; only the descendant is left in the group.
    await new Promise((resolveExit) => child.once("exit", resolveExit))

    const stopped = await stopChild(child)
    assert.equal(stopped, true)

    let alive = true
    for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0)
      } catch {
        alive = false
        break
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }

    assert.equal(alive, false, `the descendant ${descendantPid} survived the teardown`)
  } finally {
    try {
      process.kill(descendantPid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
})
