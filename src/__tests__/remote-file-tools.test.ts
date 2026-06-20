import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { exec as execCallback } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  buildFindCommand,
  buildFindFallbackCommand,
  buildGrepCommand,
  buildGrepFallbackCommand,
  buildListDirFallbackCommand,
  buildListDirCommand,
  buildReadFileContentCommand,
  buildReadFileMetadataCommand,
  buildStatFallbackCommand,
  buildStatCommand,
  fallbackListDirFromEntries,
  fallbackStatFromRemoteStat,
  formatReadFileResult,
  parseFindOutput,
  parseGrepOutput,
  parseListDirOutput,
  parseReadFileMetadata,
  parseStatOutput,
} from "../remote-file-tools.js"
import type { DirEntry, RemoteFileStat } from "../remote-fs.js"

const exec = promisify(execCallback)

describe("remote file tool command builders", () => {
  it("reads file metadata before content and never cats the whole file", () => {
    const metaCommand = buildReadFileMetadataCommand("/tmp/a $(boom).txt")
    const contentCommand = buildReadFileContentCommand("/tmp/a $(boom).txt", 10, 20)

    assert.match(metaCommand, /wc -c/)
    assert.match(metaCommand, /grep -Iq/)
    assert.match(metaCommand, /size_bytes.*0/)
    assert.doesNotMatch(contentCommand, /\bcat\b/)
    assert.match(contentCommand, /sed -n '11,30p'/)
    assert.match(contentCommand, /head -c 1048577/)
    assert.match(contentCommand, /'\/tmp\/a \$\(boom\)\.txt'/)
  })

  it("builds structured GNU list/stat/find commands", () => {
    assert.match(buildListDirCommand("/var/log", false), /find '\/var\/log' -maxdepth 1/)
    assert.match(buildListDirCommand("/var/log", true), /-printf/)
    assert.match(buildStatCommand("/var/log/syslog"), /stat -c/)
    assert.match(buildFindCommand({ path: "/repo", name: "*.ts", type: "f", maxDepth: 2 }), /-printf/)
  })

  it("builds portable fallback commands when GNU flags are unavailable", () => {
    assert.match(buildListDirFallbackCommand("/var/log", false), /^sh -c /)
    assert.match(buildListDirFallbackCommand("/var/log", false), /case "\$name" in/)
    assert.match(buildStatFallbackCommand("/var/log/syslog"), /^sh -c /)
    assert.match(buildGrepFallbackCommand({ path: "/repo", pattern: "needle" }), /^grep -RInI /)
    assert.doesNotMatch(buildGrepFallbackCommand({ path: "/repo", pattern: "needle" }), /Z/)
    assert.match(buildFindFallbackCommand({ path: "/repo", type: "f" }), /-exec sh -c/)
  })

  it("portable list fallback returns no fake entry for empty directories", async () => {
    const dir = join(process.cwd(), `tmp-empty-list-${Date.now()}-${process.pid}`)
    await mkdir(dir, { recursive: true })
    try {
      const { stdout } = await exec(buildListDirFallbackCommand(dir, false))
      assert.equal(stdout, "")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("portable stat fallback fails when ls cannot stat the path", async () => {
    const missingPath = join(process.cwd(), `tmp-missing-stat-${Date.now()}-${process.pid}`)

    await assert.rejects(
      exec(buildStatFallbackCommand(missingPath)),
      (err: any) => {
        assert.equal(err.code, 1)
        assert.equal(err.stdout, "")
        return true
      },
    )
  })

  it("quotes grep inputs and emits line-numbered recursive output", () => {
    const command = buildGrepCommand({
      path: "/repo",
      pattern: "hello $(bad)",
      glob: "*.ts",
      caseInsensitive: true,
    })

    assert.match(command, /^grep -RInIZ/)
    assert.match(command, /--include='\*\.ts'/)
    assert.match(command, /'hello \$\(bad\)'/)
  })
})

describe("remote file tool parsers", () => {
  it("parses read_file metadata with binary and size information", () => {
    const parsed = parseReadFileMetadata("size_bytes=1048577\ntotal_lines=42\nbinary_detected=true\nencoding=utf-8\n")

    assert.deepEqual(parsed, {
      sizeBytes: 1048577,
      totalLines: 42,
      binaryDetected: true,
      encoding: "utf-8",
    })
  })

  it("parses list_dir entries into stable machine-readable fields", () => {
    const parsed = parseListDirOutput("/tmp", "file.txt\tf\t12\t644\t1710000000\t/tmp/file.txt\nlogs\td\t0\t755\t1710000001\t/tmp/logs\n")

    assert.equal(parsed.entries.length, 2)
    assert.deepEqual(parsed.entries[0], {
      name: "file.txt",
      path: "/tmp/file.txt",
      type: "file",
      sizeBytes: 12,
      mode: "644",
      mtime: 1710000000,
    })
    assert.equal(parsed.entries[1].type, "directory")
  })

  it("normalizes symbolic modes from portable fallback output", () => {
    const listed = parseListDirOutput("/tmp", "file.txt\tf\t12\t-rw-r--r--\t0\t/tmp/file.txt\nlogs\td\t0\tdrwxr-xr-x\t0\t/tmp/logs\n")
    assert.deepEqual(listed.entries.map(entry => entry.mode), ["644", "755"])

    const stat = parseStatOutput("file\t12\t-rw-r-----\talice\tstaff\t0\t/tmp/file.txt\n")
    assert.equal(stat.type, "file")
    assert.equal(stat.mode, "640")
  })

  it("parses stat output into owner/group/mode/type fields", () => {
    const parsed = parseStatOutput("regular file\t99\t600\talice\tstaff\t1710000002\t/home/a/file.txt\n")

    assert.deepEqual(parsed, {
      path: "/home/a/file.txt",
      type: "file",
      sizeBytes: 99,
      mode: "600",
      owner: "alice",
      group: "staff",
      mtime: 1710000002,
    })
  })

  it("parses grep output without being confused by colons in paths or text", () => {
    const parsed = parseGrepOutput("/repo/a:b.ts\x0017:value: still ok\n")

    assert.deepEqual(parsed.matches, [{
      file: "/repo/a:b.ts",
      line: 17,
      text: "value: still ok",
    }])
    assert.equal(parsed.count, 1)
    assert.equal(parsed.noMatches, false)
  })

  it("parses find output into structured results", () => {
    const parsed = parseFindOutput("/repo/a.ts\tf\t8\t1710000003\n/repo/src\td\t0\t1710000004\n")

    assert.equal(parsed.count, 2)
    assert.deepEqual(parsed.results.map(r => r.type), ["file", "directory"])
  })

  it("formats read_file results with binary and truncation guidance", () => {
    const binary = formatReadFileResult({
      path: "/tmp/blob.bin",
      metadata: { sizeBytes: 3, totalLines: 0, binaryDetected: true, encoding: "utf-8" },
    })
    assert.equal(binary.binaryDetected, true)
    assert.equal(binary.content, "")
    assert.ok(binary.agentGuidance[0].includes("ssh_download"))

    const text = formatReadFileResult({
      path: "/tmp/app.log",
      metadata: { sizeBytes: 2_000_000, totalLines: 5000, binaryDetected: false, encoding: "utf-8" },
      rawContent: "a\nb\n",
      offset: 10,
      limit: 2,
    })
    assert.equal(text.content, "11\ta\n12\tb")
    assert.equal(text.truncated, true)
    assert.equal(text.maxContentBytes, 1048576)
  })

  it("builds structured fallback data from SFTP directory entries and stats", () => {
    const stat: RemoteFileStat = {
      size: 12,
      uid: 1000,
      gid: 1000,
      mode: 0o100644,
      atime: 1000,
      mtime: 2000,
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    }
    const entries: DirEntry[] = [
      { filename: "file.txt", longname: "", attrs: stat },
      { filename: ".hidden", longname: "", attrs: { ...stat, size: 1 } },
    ]

    const listed = fallbackListDirFromEntries("/tmp", entries, false)
    assert.deepEqual(listed.entries.map(e => e.name), ["file.txt"])
    assert.equal(listed.entries[0].mode, "644")

    const statPayload = fallbackStatFromRemoteStat("/tmp/file.txt", stat)
    assert.equal(statPayload.type, "file")
    assert.equal(statPayload.sizeBytes, 12)
    assert.equal(statPayload.mode, "644")
  })
})
