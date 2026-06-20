import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildFindCommand,
  buildGrepCommand,
  buildListDirCommand,
  buildReadFileContentCommand,
  buildReadFileMetadataCommand,
  buildStatCommand,
  parseFindOutput,
  parseGrepOutput,
  parseListDirOutput,
  parseReadFileMetadata,
  parseStatOutput,
} from "../remote-file-tools.js"

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
})
