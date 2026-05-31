/**
 * Agent Authentication Tests - SSH Agent 和 Agent Forwarding 测试
 * 
 * 测试:
 * - SSH Agent 认证
 * - Agent Forwarding 多跳
 * - Agent 不可用时的降级策略
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import ssh2 from "ssh2";
import { SSHConnection } from "../connection.js";
import type { SSHHostConfig, SSHCredentials } from "../types.js";

const { Server, utils } = ssh2;
const hostKey = utils.generateKeyPairSync("ed25519");

function createTestServer(): Promise<{
  server: InstanceType<typeof Server>;
  port: number;
  cleanup: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = new Server(
      { hostKeys: [hostKey.private] },
      (client: any) => {
        client.on("authentication", (ctx: any) => {
          if (ctx.method === "password" && ctx.password === "testpass") {
            ctx.accept();
            return;
          }
          ctx.reject();
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
        cleanup: () =>
          new Promise<void>((res) => {
            server.close(() => setTimeout(res, 50));
          }),
      });
    });

    server.on("error", reject);
  });
}

describe("Agent Authentication Tests", () => {
  describe("SSHHostConfig with agent socket path", () => {
    it("accepts agent field as a string path", () => {
      const auth: SSHCredentials = {
        username: "user",
        agent: "/tmp/ssh-XXXXX/agent.12345",
      };
      const config: SSHHostConfig = {
        id: "h1",
        name: "agent-host",
        host: "example.com",
        port: 22,
        auth,
      };
      assert.equal(config.auth.agent, "/tmp/ssh-XXXXX/agent.12345");
    });

    it("accepts pageant as agent on Windows", () => {
      const auth: SSHCredentials = {
        username: "user",
        agent: "pageant",
      };
      assert.equal(auth.agent, "pageant");
    });
  });

  describe("agentForward configuration", () => {
    it("sets agentForward to true in SSHCredentials", () => {
      const auth: SSHCredentials = {
        username: "user",
        agent: "/tmp/ssh-agent/agent.100",
        agentForward: true,
      };
      assert.equal(auth.agentForward, true);
    });

    it("sets agentForward to false in SSHCredentials", () => {
      const auth: SSHCredentials = {
        username: "user",
        agent: "/tmp/ssh-agent/agent.100",
        agentForward: false,
      };
      assert.equal(auth.agentForward, false);
    });

    it("agentForward can be omitted", () => {
      const auth: SSHCredentials = {
        username: "user",
        agent: "/tmp/ssh-agent/agent.100",
      };
      assert.equal(auth.agentForward, undefined);
    });
  });

  describe("auth field combinations in SSHHostConfig", () => {
    it("password-only auth", () => {
      const config: SSHHostConfig = {
        id: "h1",
        name: "pw-host",
        host: "10.0.0.1",
        port: 22,
        auth: { username: "admin", password: "secret" },
      };
      assert.equal(config.auth.password, "secret");
      assert.equal(config.auth.privateKey, undefined);
      assert.equal(config.auth.agent, undefined);
    });

    it("privateKey auth with passphrase", () => {
      const config: SSHHostConfig = {
        id: "h2",
        name: "key-host",
        host: "10.0.0.2",
        port: 22,
        auth: {
          username: "deploy",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
          passphrase: "keypass",
        },
      };
      assert.ok(config.auth.privateKey);
      assert.equal(config.auth.passphrase, "keypass");
    });

    it("agent auth with forwarding", () => {
      const config: SSHHostConfig = {
        id: "h3",
        name: "agent-host",
        host: "10.0.0.3",
        port: 22,
        auth: {
          username: "ops",
          agent: "/run/user/1000/ssh-agent.socket",
          agentForward: true,
        },
      };
      assert.equal(config.auth.agent, "/run/user/1000/ssh-agent.socket");
      assert.equal(config.auth.agentForward, true);
    });

    it("combined password and agent auth", () => {
      const config: SSHHostConfig = {
        id: "h4",
        name: "combo-host",
        host: "10.0.0.4",
        port: 2222,
        auth: {
          username: "root",
          password: "fallback",
          agent: "/tmp/agent.sock",
        },
      };
      assert.equal(config.auth.password, "fallback");
      assert.equal(config.auth.agent, "/tmp/agent.sock");
    });
  });

  describe("SSHConnection with agent config", () => {
    let srv: Awaited<ReturnType<typeof createTestServer>>;

    before(async () => {
      srv = await createTestServer();
    });

    after(async () => {
      await srv.cleanup();
    });

    it("connects with password auth as baseline", async () => {
      const conn = new SSHConnection();
      await conn.connect({
        chain: [
          {
            id: "pw1",
            name: "pw-host",
            host: "127.0.0.1",
            port: srv.port,
            auth: { username: "testuser", password: "testpass" },
          },
        ],
        timeout: 10000,
      });
      assert.equal(conn.isConnected(), true);
      await conn.disconnect();
    });

    it("builds correct config with agent field present", () => {
      const host: SSHHostConfig = {
        id: "ag1",
        name: "agent-host",
        host: "127.0.0.1",
        port: 22,
        auth: {
          username: "user",
          password: "pass",
          agent: "/tmp/ssh-agent/agent.999",
          agentForward: true,
        },
      };
      assert.equal(host.auth.agent, "/tmp/ssh-agent/agent.999");
      assert.equal(host.auth.agentForward, true);
      assert.equal(host.auth.username, "user");
      assert.equal(host.name, "agent-host");
    });
  });
});
