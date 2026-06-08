/**
 * Daemon IPC Tests - Daemon IPC 通信测试
 * 
 * 测试:
 * - IPC 消息编码/解码
 * - 连接管理
 * - Session 复用通过 IPC
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeMessage,
  parseMessages,
  IPCMessageParser,
  normalizeConfig,
  createRequest,
} from "../ipc-protocol.js";
import type { IPCRequest, IPCResponse } from "../ipc-protocol.js";

describe("Daemon IPC Tests", () => {
  describe("encodeMessage", () => {
    it("returns a string (JSON + newline)", () => {
      const msg: IPCRequest = { id: "r1", action: "ping" };
      const encoded = encodeMessage(msg);
      assert.equal(typeof encoded, "string");
      assert.ok(encoded.endsWith("\n"));
    });

    it("encodes a request correctly", () => {
      const msg: IPCRequest = {
        id: "r1",
        action: "connect",
        params: { configPath: "/tmp/config.json" },
      };
      const encoded = encodeMessage(msg);
      const parsed = JSON.parse(encoded.trim());
      assert.equal(parsed.id, "r1");
      assert.equal(parsed.action, "connect");
      assert.equal(parsed.params.configPath, "/tmp/config.json");
    });

    it("encodes a success response correctly", () => {
      const resp: IPCResponse = { id: "r2", ok: true, data: { sessions: [] } };
      const encoded = encodeMessage(resp);
      const parsed = JSON.parse(encoded.trim());
      assert.equal(parsed.id, "r2");
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.data, { sessions: [] });
    });

    it("encodes an error response correctly", () => {
      const resp: IPCResponse = { id: "r3", ok: false, error: "not found" };
      const encoded = encodeMessage(resp);
      const parsed = JSON.parse(encoded.trim());
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error, "not found");
    });
  });

  describe("parseMessages", () => {
    it("parses a single message from buffer", () => {
      const msg: IPCRequest = { id: "p1", action: "ping" };
      const buf = Buffer.from(encodeMessage(msg));
      const received: (IPCRequest | IPCResponse)[] = [];
      parseMessages(buf, (m) => received.push(m));
      assert.equal(received.length, 1);
      assert.equal((received[0] as IPCRequest).id, "p1");
    });

    it("parses multiple messages from buffer", () => {
      const raw =
        encodeMessage({ id: "m1", action: "ping" }) +
        encodeMessage({ id: "m2", action: "shutdown" }) +
        encodeMessage({ id: "m3", action: "list" });
      const buf = Buffer.from(raw);
      const received: (IPCRequest | IPCResponse)[] = [];
      parseMessages(buf, (m) => received.push(m));
      assert.equal(received.length, 3);
      assert.equal((received[0] as IPCRequest).id, "m1");
      assert.equal((received[1] as IPCRequest).id, "m2");
      assert.equal((received[2] as IPCRequest).id, "m3");
    });

    it("returns remaining buffer for partial messages", () => {
      const full = encodeMessage({ id: "part1", action: "ping" });
      const partial = full.slice(0, 10);
      const buf = Buffer.from(partial);
      const received: (IPCRequest | IPCResponse)[] = [];
      const remainder = parseMessages(buf, (m) => received.push(m));
      assert.equal(received.length, 0);
      assert.ok(remainder.length > 0);
    });

    it("assembles message across incremental chunks", () => {
      const full = encodeMessage({ id: "inc1", action: "ping" });
      const mid = Math.floor(full.length / 2);
      const part1 = Buffer.from(full.slice(0, mid));
      const part2 = Buffer.from(full.slice(mid));
      const received: (IPCRequest | IPCResponse)[] = [];
      let remainder = parseMessages(part1, (m) => received.push(m));
      assert.equal(received.length, 0);
      remainder = parseMessages(
        Buffer.concat([remainder, part2]),
        (m) => received.push(m),
      );
      assert.equal(received.length, 1);
      assert.equal((received[0] as IPCRequest).id, "inc1");
    });

    it("skips malformed lines", () => {
      const good = encodeMessage({ id: "good1", action: "ping" });
      const raw = "not valid json\n" + good + "another bad line\n";
      const buf = Buffer.from(raw);
      const received: (IPCRequest | IPCResponse)[] = [];
      parseMessages(buf, (m) => received.push(m));
      assert.equal(received.length, 1);
      assert.equal((received[0] as IPCRequest).id, "good1");
    });

    it("handles empty buffer", () => {
      const buf = Buffer.alloc(0);
      const received: (IPCRequest | IPCResponse)[] = [];
      const remainder = parseMessages(buf, (m) => received.push(m));
      assert.equal(received.length, 0);
      assert.equal(remainder.length, 0);
    });
  });

  describe("IPCMessageParser", () => {
    it("parses incremental string chunks without caller-side Buffer concatenation", () => {
      const parser = new IPCMessageParser();
      const received: (IPCRequest | IPCResponse)[] = [];
      const raw =
        encodeMessage({ id: "s1", action: "ping" }) +
        encodeMessage({ id: "s2", action: "list" });

      for (const ch of raw) {
        parser.push(Buffer.from(ch), (m) => received.push(m));
      }

      assert.equal(received.length, 2);
      assert.equal((received[0] as IPCRequest).id, "s1");
      assert.equal((received[1] as IPCRequest).id, "s2");
      assert.equal(parser.remainderLength, 0);
    });

    it("keeps only the incomplete trailing line between pushes", () => {
      const parser = new IPCMessageParser();
      const received: (IPCRequest | IPCResponse)[] = [];
      const raw = encodeMessage({ id: "partial-parser", action: "ping" });

      parser.push(Buffer.from(raw.slice(0, -2)), (m) => received.push(m));
      assert.equal(received.length, 0);
      assert.equal(parser.remainderLength, raw.length - 2);

      parser.push(Buffer.from(raw.slice(-2)), (m) => received.push(m));
      assert.equal(received.length, 1);
      assert.equal((received[0] as IPCRequest).id, "partial-parser");
      assert.equal(parser.remainderLength, 0);
    });
  });

  describe("normalizeConfig", () => {
    it("sorts top-level keys", () => {
      const a = JSON.stringify({ z: 1, a: 2 });
      assert.equal(normalizeConfig(a), '{"a":2,"z":1}');
    });

    it("sorts nested object keys", () => {
      const a = JSON.stringify({ host: "h", auth: { password: "p", username: "u" } });
      const b = JSON.stringify({ auth: { username: "u", password: "p" }, host: "h" });
      assert.equal(normalizeConfig(a), normalizeConfig(b));
    });

    it("treats different values as different", () => {
      const a = normalizeConfig(JSON.stringify({ host: "a.com" }));
      const b = normalizeConfig(JSON.stringify({ host: "b.com" }));
      assert.notEqual(a, b);
    });

    it("preserves array order", () => {
      const a = normalizeConfig(JSON.stringify({ arr: [3, 1, 2] }));
      const b = normalizeConfig(JSON.stringify({ arr: [1, 2, 3] }));
      assert.notEqual(a, b);
    });
  });

  describe("createRequest", () => {
    it("creates a ping request", () => {
      const req = createRequest("ping");
      assert.ok(req.id);
      assert.equal(req.action, "ping");
    });

    it("creates a shutdown request", () => {
      const req = createRequest("shutdown");
      assert.ok(req.id);
      assert.equal(req.action, "shutdown");
    });

    it("creates a list request", () => {
      const req = createRequest("list");
      assert.ok(req.id);
      assert.equal(req.action, "list");
    });

    it("creates a connect request with params", () => {
      const req = createRequest("connect", { configPath: "/tmp/c.json" }) as Extract<
        IPCRequest,
        { action: "connect" }
      >;
      assert.equal(req.action, "connect");
      assert.equal(req.params.configPath, "/tmp/c.json");
    });

    it("creates an exec request with params", () => {
      const req = createRequest("exec", {
        sessionId: "s1",
        command: "ls",
        timeout: 5000,
      }) as Extract<IPCRequest, { action: "exec" }>;
      assert.equal(req.action, "exec");
      assert.equal(req.params.sessionId, "s1");
      assert.equal(req.params.command, "ls");
      assert.equal(req.params.timeout, 5000);
    });

    it("creates a disconnect request with params", () => {
      const req = createRequest("disconnect", {
        sessionId: "s1",
      }) as Extract<IPCRequest, { action: "disconnect" }>;
      assert.equal(req.action, "disconnect");
      assert.equal(req.params.sessionId, "s1");
    });
  });
});
