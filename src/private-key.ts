/**
 * Private-key resolution for SSH credentials.
 *
 * Profiles historically stored a filesystem PATH in `auth.privateKey`; feeding
 * that path to ssh2 as PEM content produced "Unsupported key format". This
 * module distinguishes path vs inline content, reads the file when a path is
 * detected, and normalizes line endings so serialized profiles can't corrupt
 * the key.
 */

import { existsSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { isAbsolute, join, resolve } from "path"

const PRIVATE_KEY_HEADER = /-----BEGIN (OPENSSH|RSA|EC|DSA|SSH2 ENCRYPTED) PRIVATE KEY-----/
const PUBLIC_KEY_HEADER = /-----BEGIN (\w+ )?PUBLIC KEY-----/
const PUBLIC_KEY_ONELINER = /^(ssh|ecdsa|sk-)\S+\s+AAAA[A-Za-z0-9+/]+/

/** CRLF→LF 归一，并确保恰好一个结尾换行。 */
function normalizeKeyContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd()
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`
}

export function resolvePrivateKeyContent(input: string): string {
  const value = input.trim()
  if (!value) {
    throw new Error("Empty private key value")
  }

  if (value.startsWith("-----BEGIN")) {
    if (PUBLIC_KEY_HEADER.test(value)) {
      throw new Error(
        "privateKey looks like a PUBLIC key (-----BEGIN PUBLIC KEY-----), not a private key. Generate a private key with `ssh-keygen -t ed25519`.",
      )
    }
    if (!PRIVATE_KEY_HEADER.test(value)) {
      throw new Error(
        `Unrecognized private key header. Convert the key first, e.g. \`ssh-keygen -p -f <file>\` (value starts: ${value.slice(0, 40)}…).`,
      )
    }
    return normalizeKeyContent(value)
  }

  if (PUBLIC_KEY_ONELINER.test(value)) {
    throw new Error(
      "privateKey looks like a PUBLIC key (ssh-ed25519 AAAA…), not a private key. Generate a private key with `ssh-keygen -t ed25519`.",
    )
  }

  // 多行内容但无 PEM 头：视为已损坏内容，归一后交给 ssh2 报错。
  if (value.includes("\n")) {
    return normalizeKeyContent(value)
  }

  // 否则按文件路径处理：~ 展开、相对 cwd 解析；命中文件则递归校验内容头。
  const expanded = value.startsWith("~") ? join(homedir(), value.slice(1)) : value
  const abs = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
  if (existsSync(abs) && statSync(abs).isFile()) {
    return resolvePrivateKeyContent(readFileSync(abs, "utf8"))
  }

  throw new Error(
    `privateKey looks like a file path but the file does not exist: ${input}. Use an absolute path to the key file, or paste the key content directly.`,
  )
}
