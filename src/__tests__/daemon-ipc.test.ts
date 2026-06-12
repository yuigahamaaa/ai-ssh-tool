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

    it("throws when remainder exceeds maxRemainderBytes limit", () => {
      const parser = new IPCMessageParser(100);
      const bigData = Buffer.from("x".repeat(150));
      assert.throws(
        () => parser.push(bigData, () => {}),
        (err: Error) => {
          assert.ok(err.message.includes("max size"));
          return true;
        },
      );
    });

    it("recovers after maxRemainderBytes error", () => {
      const parser = new IPCMessageParser(100);
      const bigData = Buffer.from("x".repeat(150));
      try { parser.push(bigData, () => {}); } catch {}
      // remainder should be reset
      assert.equal(parser.remainderLength, 0);
      // normal messages should still work
      const received: any[] = [];
      const raw = encodeMessage({ id: "recovery", action: "ping" });
      parser.push(Buffer.from(raw), (m) => received.push(m));
      assert.equal(received.length, 1);
      assert.equal((received[0] as any).id, "recovery");
    });

    it("error message reports the actual size and configured limit", () => {
      const parser = new IPCMessageParser(512);
      const big = "y".repeat(1024);
      let caught: Error | null = null;
      try {
        parser.push(Buffer.from(big), () => {});
      } catch (err) {
        caught = err as Error;
      }
      assert.ok(caught, "expected throw");
      assert.ok(caught!.message.includes("1024 bytes"), "should report actual size");
      assert.ok(caught!.message.includes("512 bytes limit"), "should report configured limit");
    });

    it("throws when default 16MB limit is exceeded", () => {
      const parser = new IPCMessageParser();
      // 17MB of data without any newlines pushes remainder over the default
      // limit. The push itself is what throws; the buffer is sized so the
      // test runs in reasonable time on a developer machine.
      const oversize = "z".repeat(17 * 1024 * 1024);
      let caught: Error | null = null;
      try {
        parser.push(Buffer.from(oversize), () => {});
      } catch (err) {
        caught = err as Error;
      }
      assert.ok(caught, "default limit should throw on >16MB");
      assert.ok(caught!.message.includes("16MB") || caught!.message.includes("16777216"), "should mention the default 16MB cap");
    });

    it("throws when incremental pushes accumulate past the limit", () => {
      // Split a 250-byte payload across two pushes. After the first push the
      // remainder is 100 bytes (under the 200-byte limit). The second push
      // brings the cumulative remainder to 250 bytes, which trips the
      // limit. The error must be thrown on the second push, not deferred.
      const parser = new IPCMessageParser(200);
      const part1 = "a".repeat(100);
      const part2 = "b".repeat(150);
      parser.push(Buffer.from(part1), () => {});
      assert.equal(parser.remainderLength, 100);
      assert.throws(
        () => parser.push(Buffer.from(part2), () => {}),
        (err: Error) => {
          assert.ok(err.message.includes("max size"));
          return true;
        },
      );
    });

    it("reports the cumulative buffered size when incremental pushes exceed the limit", () => {
      const parser = new IPCMessageParser(200);
      parser.push(Buffer.from("a".repeat(100)), () => {});

      let caught: Error | null = null;
      try {
        parser.push(Buffer.from("b".repeat(150)), () => {});
      } catch (err) {
        caught = err as Error;
      }

      assert.ok(caught, "expected an over-limit error on the second push");
      assert.ok(caught!.message.includes("250 bytes"), "should report the cumulative buffered size");
      assert.ok(caught!.message.includes("200 bytes limit"), "should report the configured limit");
    });

    it("does not throw when pushes stay at or just under the limit", () => {
      const parser = new IPCMessageParser(200);
      // 200 bytes of data with no newline fits exactly at the cap
      parser.push(Buffer.from("a".repeat(200)), () => {});
      assert.equal(parser.remainderLength, 200);
      // 199 more bytes brings us to 399 — well over the cap and must throw
      assert.throws(() => parser.push(Buffer.from("b".repeat(199)), () => {}));
    });

    it("reusable after a limit error: multiple recovers in sequence", () => {
      const parser = new IPCMessageParser(100);
      const oversize = Buffer.from("x".repeat(150));
      try { parser.push(oversize, () => {}); } catch {}
      assert.equal(parser.remainderLength, 0);

      const ok1 = encodeMessage({ id: "ok-1", action: "ping" });
      const received1: any[] = [];
      parser.push(Buffer.from(ok1), (m) => received1.push(m));
      assert.equal(received1.length, 1);

      // Trigger another over-limit push and recover again
      try { parser.push(Buffer.from("y".repeat(150)), () => {}); } catch {}
      assert.equal(parser.remainderLength, 0);
      const ok2 = encodeMessage({ id: "ok-2", action: "list" });
      const received2: any[] = [];
      parser.push(Buffer.from(ok2), (m) => received2.push(m));
      assert.equal(received2.length, 1);
      assert.equal(received2[0].id, "ok-2");
    });

    it("emits no messages for an over-limit push", () => {
      const parser = new IPCMessageParser(100);
      const received: any[] = [];
      let caught: Error | null = null;
      try {
        parser.push(Buffer.from("not-json-at-all-" + "x".repeat(200)), (m) => received.push(m));
      } catch (err) {
        caught = err as Error;
      }
      assert.ok(caught);
      assert.equal(received.length, 0, "no partial messages should be emitted on limit error");
      assert.equal(parser.remainderLength, 0, "remainder must be reset so garbage doesn't linger");
    });

    it("partial message inside an oversize remainder is discarded on reset", () => {
      const parser = new IPCMessageParser(100);
      // Stuff the buffer with an incomplete frame (no newline) that exceeds
      // the limit. The pending partial message should be discarded — not
      // resurrected on the next valid push.
      const partial = `{ "id": "never-emitted", "action": "ping", "junk": "${"x".repeat(120)}"`
      assert.ok(partial.length > 100)
      try { parser.push(Buffer.from(partial), () => {}); } catch {}
      const next = encodeMessage({ id: "fresh", action: "list" })
      const received: any[] = []
      parser.push(Buffer.from(next), (m) => received.push(m))
      assert.equal(received.length, 1)
      assert.equal(received[0].id, "fresh")
    })

    it("daemon socket handler catches parser throw and destroys the socket", () => {
      // Simulate the daemon-side socket data handler logic: when parser.push
      // throws (over-limit), we send an error response and destroy the socket.
      const parser = new IPCMessageParser(50)
      let socketDestroyed = false
      let errorWritten = false
      const mockSocket = {
        write: (data: string) => {
          const parsed = JSON.parse(data.trim())
          errorWritten = true
          assert.equal(parsed.ok, false)
          assert.ok(parsed.error.includes("exceeded max size"))
          assert.equal(parsed.id, "max-remainder")
        },
        destroy: () => { socketDestroyed = true },
      } as unknown as { write: (s: string) => void; destroy: () => void }

      try {
        parser.push(Buffer.from("x".repeat(80)), () => {})
      } catch (err: any) {
        // Simulate daemon-side handler: write error + destroy
        const errorResp: IPCResponse = { id: "max-remainder", ok: false, error: err.message }
        mockSocket.write(encodeMessage(errorResp))
        mockSocket.destroy()
      }

      assert.equal(socketDestroyed, true, "socket should be destroyed")
      assert.equal(errorWritten, true, "error response should be written")
    })
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
