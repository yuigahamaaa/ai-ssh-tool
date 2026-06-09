import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { IPCSocket, encodeMessage } from "../ipc-protocol.js";
import type { IPCRequest, IPCResponse } from "../ipc-protocol.js";

function createMockSocket() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const mock = emitter as any;
  mock.write = (data: string | Buffer, cb?: (err?: Error) => void) => {
    written.push(typeof data === "string" ? data : data.toString());
    if (cb) cb();
    return true;
  };
  mock.off = emitter.off.bind(emitter);
  return { socket: mock, written };
}

function makeRequest(action: IPCRequest["action"], params?: Record<string, unknown>): IPCRequest {
  const id = `req-${Math.random().toString(36).slice(2)}`;
  if (params) return { id, action, params } as IPCRequest;
  return { id, action } as IPCRequest;
}

function sendResponse(socket: EventEmitter, resp: IPCResponse) {
  socket.emit("data", Buffer.from(encodeMessage(resp) + "\n"));
}

describe("IPCSocket", () => {
  describe("基本 send/receive", () => {
    it("发送请求并收到匹配响应后 resolve", async () => {
      const { socket, written } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req = makeRequest("ping");
      const promise = ipc.send(req);

      assert.equal(written.length, 1);
      const sent = JSON.parse(written[0].trim());
      assert.equal(sent.id, req.id);
      assert.equal(sent.action, "ping");

      const resp: IPCResponse = { id: req.id, ok: true, data: { pong: true } };
      sendResponse(socket, resp);

      const result = await promise;
      assert.equal(result.ok, true);
      assert.deepEqual((result as any).data, { pong: true });

      ipc.dispose();
    });
  });

  describe("多个并发请求", () => {
    it("同时发送多个请求，各自匹配正确的响应", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req1 = makeRequest("ping");
      const req2 = makeRequest("list");
      const req3 = makeRequest("shutdown");

      const p1 = ipc.send(req1);
      const p2 = ipc.send(req2);
      const p3 = ipc.send(req3);

      sendResponse(socket, { id: req3.id, ok: true, data: null });
      sendResponse(socket, { id: req1.id, ok: true, data: { pong: true } });
      sendResponse(socket, { id: req2.id, ok: true, data: { sessions: ["a", "b"] } });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      assert.deepEqual((r1 as any).data, { pong: true });
      assert.deepEqual((r2 as any).data, { sessions: ["a", "b"] });
      assert.equal(r3.ok, true);

      ipc.dispose();
    });
  });

  describe("超时处理", () => {
    it("请求超时后 reject", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req = makeRequest("exec", { sessionId: "s1", command: "ls" });
      await assert.rejects(
        () => ipc.send(req, 50),
        (err: Error) => {
          assert.ok(err.message.includes("timed out"));
          assert.ok(err.message.includes("exec"));
          return true;
        },
      );

      ipc.dispose();
    });

    it("超时后不会再匹配迟到的响应", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req = makeRequest("ping");
      const promise = ipc.send(req, 30);

      await assert.rejects(() => promise);

      sendResponse(socket, { id: req.id, ok: true, data: null });

      ipc.dispose();
    });
  });

  describe("socket 关闭时 rejectAll", () => {
    it("socket close 事件触发时所有 pending 请求被 reject", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req1 = makeRequest("ping");
      const req2 = makeRequest("list");

      const p1 = ipc.send(req1, 10000);
      const p2 = ipc.send(req2, 10000);

      socket.emit("close");

      await assert.rejects(p1, { message: "IPC socket closed" });
      await assert.rejects(p2, { message: "IPC socket closed" });

      ipc.dispose();
    });
  });

  describe("dispose 清理", () => {
    it("dispose 后 pending 请求被 reject", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req = makeRequest("ping");
      const promise = ipc.send(req, 10000);

      ipc.dispose();

      await assert.rejects(promise, { message: "IPC client disposed" });
    });

    it("dispose 后移除了 socket 事件监听", () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const dataListenersBefore = socket.listenerCount("data");
      const closeListenersBefore = socket.listenerCount("close");
      assert.ok(dataListenersBefore > 0);
      assert.ok(closeListenersBefore > 0);

      ipc.dispose();

      assert.equal(socket.listenerCount("data"), dataListenersBefore - 1);
      assert.equal(socket.listenerCount("close"), closeListenersBefore - 1);
    });
  });

  describe("部分消息处理", () => {
    it("数据分片到达时正确组装消息", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req = makeRequest("ping");
      const promise = ipc.send(req);

      const respStr = encodeMessage({ id: req.id, ok: true, data: { v: 1 } });
      const mid = Math.floor(respStr.length / 2);

      socket.emit("data", Buffer.from(respStr.slice(0, mid)));

      socket.emit("data", Buffer.from(respStr.slice(mid)));

      const result = await promise;
      assert.equal(result.ok, true);
      assert.deepEqual((result as any).data, { v: 1 });

      ipc.dispose();
    });
  });

  describe("错误响应", () => {
    it("ok: false 的响应被正确 resolve（不是 reject）", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req = makeRequest("connect", { configPath: "/bad/path" });
      const promise = ipc.send(req);

      const resp: IPCResponse = { id: req.id, ok: false, error: "connection refused" };
      sendResponse(socket, resp);

      const result = await promise;
      assert.equal(result.ok, false);
      assert.equal((result as any).error, "connection refused");

      ipc.dispose();
    });
  });

  describe("rejectAll", () => {
    it("rejectAll 清空所有 pending 请求", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const req1 = makeRequest("ping");
      const req2 = makeRequest("list");

      const p1 = ipc.send(req1, 10000);
      const p2 = ipc.send(req2, 10000);

      ipc.rejectAll(new Error("manual reject"));

      await assert.rejects(p1, { message: "manual reject" });
      await assert.rejects(p2, { message: "manual reject" });

      ipc.dispose();
    });

    it("rejectAll 后新的请求仍然可以正常工作", async () => {
      const { socket } = createMockSocket();
      const ipc = new IPCSocket(socket);

      const staleReq = makeRequest("ping");
      const stalePromise = ipc.send(staleReq, 10000);

      ipc.rejectAll(new Error("flush"));
      await assert.rejects(stalePromise);

      const freshReq = makeRequest("list");
      const freshPromise = ipc.send(freshReq);
      sendResponse(socket, { id: freshReq.id, ok: true, data: [] });

      const result = await freshPromise;
      assert.equal(result.ok, true);

      ipc.dispose();
    });
  });
});
