/**
 * Session Reuse Tests - Session 复用和 Config Hash 测试
 * 
 * 测试:
 * - Config Hash 计算
 * - Session 复用逻辑
 * - Config 变化检测
 * - 最大 Session 限制
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import ssh2 from "ssh2";
import { normalizeConfig } from "../ipc-protocol.js";
import { SSHSessionManager } from "../session-manager.js";
import type { SSHHostConfig } from "../types.js";

const { Server, utils } = ssh2;
const hostKey = utils.generateKeyPairSync("ed25519");

function createTestServer(): Promise<{
  server: InstanceType<typeof Server>;
  port: number;
  hostConfig: Omit<SSHHostConfig, "id">;
  cleanup: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = new Server(
      { hostKeys: [hostKey.private] },
      (client: any) => {
        client.on("authentication", (ctx: any) => {
          if (ctx.method === "password" && ctx.password === "testpass") {
            ctx.accept();
          } else {
            ctx.reject();
          }
        });
        client.on("ready", () => {
          client.on("session", (accept: any) => {
            const session = accept();
            session.on("pty", (accept: any) => { accept() })
          session.on("window-change", (accept: any) => { if (accept) accept() })
          session.on("shell", (accept: any) => { const s = accept(); s.on("close", () => {}) })
          session.on("exec", (acceptExec: any) => {
              const stream = acceptExec();
              stream.write("ok\n");
              stream.exit(0);
              stream.close();
            });
          });
        });
      },
    );

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        hostConfig: {
          name: "test-host",
          host: "127.0.0.1",
          port: addr.port,
          auth: { username: "testuser", password: "testpass" },
        },
        cleanup: () =>
          new Promise<void>((res) => {
            server.close(() => setTimeout(res, 50));
          }),
      });
    });

    server.on("error", reject);
  });
}

describe("Session Reuse Tests", () => {
  describe("normalizeConfig deep key sorting", () => {
    it("produces same result when nested object keys are reordered", () => {
      const config1 = JSON.stringify({
        auth: { password: "pass", username: "user" },
        host: "example.com",
        port: 22,
      });
      const config2 = JSON.stringify({
        host: "example.com",
        port: 22,
        auth: { username: "user", password: "pass" },
      });

      assert.equal(normalizeConfig(config1), normalizeConfig(config2));
    });

    it("sorts deeply nested objects consistently", () => {
      const config1 = JSON.stringify({
        z: { b: 1, a: 2 },
        a: { z: { b: 1, a: 2 }, a: { b: 1, a: 2 } },
      });
      const config2 = JSON.stringify({
        a: { a: { a: 2, b: 1 }, z: { a: 2, b: 1 } },
        z: { a: 2, b: 1 },
      });

      assert.equal(normalizeConfig(config1), normalizeConfig(config2));
    });

    it("produces different result for different values", () => {
      const config1 = JSON.stringify({ host: "example.com", port: 22 });
      const config2 = JSON.stringify({ host: "different.com", port: 22 });

      assert.notEqual(normalizeConfig(config1), normalizeConfig(config2));
    });

    it("preserves array order (arrays are not sorted)", () => {
      const config1 = JSON.stringify({ items: [3, 1, 2] });
      const config2 = JSON.stringify({ items: [1, 2, 3] });

      assert.notEqual(normalizeConfig(config1), normalizeConfig(config2));
    });
  });

  describe("SSHHostConfig name field", () => {
    it("requires name field in SSHHostConfig", () => {
      const config: SSHHostConfig = {
        id: "test-1",
        name: "my-server",
        host: "example.com",
        port: 22,
        auth: { username: "user" },
      };
      assert.equal(config.name, "my-server");
    });
  });

  describe("SessionManager connection management", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>;

    before(async () => {
      srv = await createTestServer();
    });

    after(async () => {
      await srv.cleanup();
    });

    it("creates, lists, retrieves, and disconnects sessions", async () => {
      const manager = new SSHSessionManager({ maxSessions: 5 });

      const session = await manager.connect({
        chain: [{ id: "t1", ...srv.hostConfig }],
        timeout: 10000,
      });

      assert.ok(session.id);
      assert.equal(session.status, "connected");
      assert.equal(manager.listSessions().length, 1);
      assert.equal(manager.getSession(session.id)?.id, session.id);
      assert.equal(manager.hasSession(session.id), true);

      await manager.disconnect(session.id);
      assert.equal(manager.listSessions().length, 0);
      assert.equal(manager.hasSession(session.id), false);
      assert.equal(manager.getSession(session.id), undefined);
    });

    it("disconnects all sessions at once", async () => {
      const manager = new SSHSessionManager({ maxSessions: 5 });

      await manager.connect({
        chain: [{ id: "a1", ...srv.hostConfig }],
        timeout: 10000,
      });
      await manager.connect({
        chain: [{ id: "a2", ...srv.hostConfig }],
        timeout: 10000,
      });

      assert.equal(manager.listSessions().length, 2);
      await manager.disconnectAll();
      assert.equal(manager.listSessions().length, 0);
    });
  });

  describe("SessionManager max sessions limit", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>;

    before(async () => {
      srv = await createTestServer();
    });

    after(async () => {
      await srv.cleanup();
    });

    it("rejects connection when max sessions reached", async () => {
      const manager = new SSHSessionManager({ maxSessions: 2 });

      const s1 = await manager.connect({
        chain: [{ id: "m1", ...srv.hostConfig }],
        timeout: 10000,
      });
      const s2 = await manager.connect({
        chain: [{ id: "m2", ...srv.hostConfig }],
        timeout: 10000,
      });

      await assert.rejects(
        () =>
          manager.connect({
            chain: [{ id: "m3", ...srv.hostConfig }],
            timeout: 10000,
          }),
        /Maximum concurrent sessions/,
      );

      await manager.disconnect(s1.id);
      await manager.disconnect(s2.id);
    });
  });
});
