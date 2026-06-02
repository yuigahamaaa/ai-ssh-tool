/**
 * 完整测试设计方案 - ai-ssh-tool
 *
 * 本文档定义项目的测试策略、测试用例和测试覆盖目标
 * 包含：单元测试、集成测试、性能测试、异常测试、安全测试
 */

## 一、测试金字塔

```
                    ┌─────────────────┐
                    │   E2E Tests     │  ← 少量关键场景
                    │  (手动/自动化)   │
                  ├─────────────────┤
                  │  Integration    │  ← 核心业务流程
                  │    Tests         │
                ├─────────────────────┤
                │      Unit Tests     │  ← 大量快速测试
                │   (mock/isolate)    │
                └─────────────────────┘
```

## 二、测试分类

### 2.1 单元测试 (Unit Tests)

**目标**：快速验证每个模块的独立逻辑

#### A. Connection 模块
```typescript
// ✅ 已有：空链检验
// ✅ 已有：状态检查（isConnected, getFinalClient）
// ✅ 已有：多跳不同认证方式 (multi-hop-auth.test.ts)
// ❌ 缺失：SSH Agent 认证
// ❌ 缺失：Agent Forwarding 多跳
// ❌ 缺失：认证方式组合（密码+私钥+Agent）

describe("SSH Agent Authentication", () => {
  it("connect with SSH agent", async () => { ... })
  it("agent forwarding through multiple hops", async () => { ... })
  it("agent not available gracefully fails", async () => { ... })
})
```

#### B. File Transfer 模块 (已有)
```typescript
// ✅ 已有：单文件上传/下载 (file-transfer.test.ts)
// ✅ 已有：大文件流式传输
// ✅ 已有：基础错误处理
// ❌ 缺失：文件夹压缩上传/下载
// ❌ 缺失：传输进度回调
// ❌ 缺失：传输中断恢复
// ❌ 缺失：性能测试 - 1GB 以上文件
```

#### F. Session Manager 模块 (已有但需补充)
```typescript
// ❌ 缺失：Config Hash 计算
// ❌ 缺失：Session 复用逻辑
// ❌ 缺失：Config 变化检测
// ❌ 缺失：最大 Session 限制

describe("Session Reuse", () => {
  it("config hash computed correctly", async () => { ... })
  it("same config reuses session", async () => { ... })
  it("different config creates new session", async () => { ... })
  it("config update invalidates cache", async () => { ... })
  it("max sessions enforced", async () => { ... })
})
```

#### G. IPC Protocol 模块 (新增)
```typescript
// ❌ 缺失：消息编码/解码
// ❌ 缺失：连接池管理
// ❌ 缺失：并发消息处理

describe("IPC Protocol", () => {
  it("encodes message correctly", async () => { ... })
  it("decodes message correctly", async () => { ... })
  it("handles partial messages", async () => { ... })
  it("handles concurrent requests", async () => { ... })
})
```

#### C. Background Exec 模块 (已有)
```typescript
// ✅ 已有：完整功能测试 (background-exec.test.ts)
```

#### D. Port Forwarding 模块 (已有)
```typescript
// ✅ 已有：基础功能测试 (port-forwarding.test.ts)
// ❌ 缺失：实际转发流量验证
// ❌ 缺失：完整的 error handling
```

#### E. MCP Server 模块 (完全缺失)
```typescript
// ❌ 缺失：所有 21 个工具的集成测试
// ❌ 缺失：stdio 通信协议
// ❌ 缺失：工具参数验证
// ❌ 缺失：错误格式响应

describe("MCP Server Tools", () => {
  // 远程执行
  it("remote_exec works", async () => { ... })
  // 文件操作
  it("remote_read_file works", async () => { ... })
  it("remote_write_file works", async () => { ... })
  it("remote_list_dir works", async () => { ... })
  it("remote_exists works", async () => { ... })
  it("remote_stat works", async () => { ... })
  it("remote_grep works", async () => { ... })
  it("remote_find works", async () => { ... })
  // 文件传输（自动判断文件 / 文件夹）
  it("upload works (auto-detect file vs folder)", async () => { ... })
  it("download works (auto-detect file vs folder)", async () => { ... })
  // 后台执行
  it("exec_background works", async () => { ... })
  it("exec_status works", async () => { ... })
  it("exec_cancel works", async () => { ... })
  it("list_tasks works", async () => { ... })
  // 端口转发
  it("local_forward works", async () => { ... })
  it("remote_forward works", async () => { ... })
  it("stop_forward works", async () => { ... })
  it("list_forwards works", async () => { ... })
})

describe("MCP Server Error Handling", () => {
  it("invalid parameters return proper error", async () => { ... })
  it("connection lost returns error", async () => { ... })
  it("invalid command rejected", async () => { ... })
})
```

### 2.2 集成测试 (Integration Tests)

**目标**：验证多模块协作

#### A. 多跳认证组合测试
```typescript
describe("Multi-hop Authentication Combinations", () => {
  // 测试跳数从 1 到 5
  for (let hops = 1; hops <= 5; hops++) {
    it(`${hops}-hop connection`, async () => { ... })
  }

  // 测试所有认证组合
  const authMethods = ['password', 'privateKey', 'agent']
  for (const hop1Auth of authMethods) {
    for (const hop2Auth of authMethods) {
      it(`hop1: ${hop1Auth}, hop2: ${hop2Auth}`, async () => { ... })
    }
  }
})
```

#### B. 完整工作流测试
```typescript
describe("Complete Workflows", () => {
  it("deploy workflow: connect → exec → upload → exec → disconnect", async () => {
    // 1. 连接
    const conn = await connect(...)
    // 2. 执行部署命令
    await exec(conn, "git pull")
    // 3. 上传配置
    await uploadFile(conn, "config.json")
    // 4. 重启服务
    await exec(conn, "systemctl restart app")
    // 5. 验证
    await exec(conn, "curl localhost:8080/health")
    // 6. 断开
    await disconnect(conn)
  })

  it("dev workflow: connect → create files → download logs", async () => {
    // 完整的开发工作流
  })
})
```

#### C. Daemon + IPC 集成
```typescript
describe("Daemon IPC Integration", () => {
  it("connect → exec → transfer → disconnect via IPC", async () => { ... })
  it("multiple sessions managed correctly", async () => { ... })
  it("session reuse with same config", async () => { ... })
  it("session not reused for different config", async () => { ... })
})
```

### 2.3 异常测试 (Error/Edge Case Tests)

```typescript
describe("Error Handling", () => {
  describe("Network Errors", () => {
    it("connection timeout", async () => { ... })
    it("connection refused", async () => { ... })
    it("connection reset during exec", async () => { ... })
    it("connection drop mid-transfer", async () => { ... })
    it("DNS resolution failure", async () => { ... })
  })

  describe("Authentication Errors", () => {
    it("wrong password", async () => {
      await assert.rejects(() => connect({ password: "wrong" }), /authentication/i)
    })
    it("wrong privateKey", async () => { ... })
    it("expired privateKey", async () => { ... })
    it("passphrase required but not provided", async () => { ... })
    it("agent not running", async () => { ... })
    it("agent key rejected by server", async () => { ... })
  })

  describe("File System Errors", () => {
    it("read nonexistent file", async () => { ... })
    it("write to readonly path", async () => { ... })
    it("upload to full disk", async () => { ... })
    it("download to full disk", async () => { ... })
    it("path with special characters", async () => { ... })
    it("path too long", async () => { ... })
    it("symlink loop detection", async () => { ... })
  })

  describe("Resource Limits", () => {
    it("command timeout", async () => { ... })
    it("output exceeds 10MB buffer", async () => { ... })
    it("too many concurrent sessions", async () => { ... })
    it("port already bound", async () => { ... })
  })

  describe("Protocol Errors", () => {
    it("invalid SFTP packet", async () => { ... })
    it("SSH protocol mismatch", async () => { ... })
    it("MCP invalid JSON request", async () => { ... })
    it("IPC malformed message", async () => { ... })
  })
})
```

### 2.4 性能测试 (Performance Tests)

```typescript
describe("Performance Tests", () => {
  describe("File Transfer", () => {
    it("1MB file < 1s", async () => {
      const start = Date.now()
      await uploadFile(conn, "1MB.bin")
      const duration = Date.now() - start
      assert.ok(duration < 1000, `Should complete in <1s, took ${duration}ms`)
    })

    it("100MB file < 30s", async () => { ... })
    it("1GB file streaming (memory < 100MB)", async () => { ... })  // 内存监控

    it("100 files sequential vs parallel", async () => {
      const seq = await measure(() => uploadAll(seq))
      const par = await measure(() => uploadAll(par, { parallel: 5 }))
      assert.ok(par < seq * 0.8, "Parallel should be faster")
    })
  })

  describe("Connection", () => {
    it("single hop connect < 2s", async () => { ... })
    it("5-hop connect < 10s", async () => { ... })
    it("session reuse instant (< 100ms)", async () => { ... })
  })

  describe("Concurrent Operations", () => {
    it("10 concurrent execs", async () => { ... })
    it("10 concurrent file transfers", async () => { ... })
    it("100 concurrent sessions memory < 500MB", async () => { ... })  // 内存监控
  })

  describe("Background Exec", () => {
    it("1000 tasks created quickly", async () => { ... })
    it("task list retrieval < 10ms", async () => { ... })
  })
})
```

### 2.5 安全测试 (Security Tests)

```typescript
describe("Security Tests", () => {
  describe("Input Validation", () => {
    it("command injection blocked", async () => {
      await assert.rejects(
        () => exec(conn, "echo $(cat /etc/passwd)"),
        /blocked/i
      )
    })
    it("path traversal blocked", async () => {
      await assert.rejects(
        () => readFile(conn, "../../../etc/passwd"),
        /blocked/i
      )
    })
    it("null byte injection blocked", async () => { ... })
  })

  describe("Security Policies", () => {
    it("readOnly: writeFile blocked", async () => { ... })
    it("commandWhitelist: exec blocked", async () => { ... })
    it("blockedPaths: sensitive paths blocked", async () => { ... })
    it("maxCommandLength: long commands blocked", async () => { ... })
  })

  describe("Credential Handling", () => {
    it("password not logged", async () => { ... })
    it("privateKey not exposed in memory dumps", async () => { ... })  // 需要特殊工具
    it("agent socket properly scoped", async () => { ... })
  })
})
```

## 三、测试数据管理

### 3.1 Mock SSH Server
```typescript
// 复用 integration.test.ts 的 mock server
// 支持配置：
// - 认证方式（password, publickey）
// - exec 行为（正常、慢、超时、错误）
// - SFTP 行为（读写、错误）
// - 网络延迟模拟
```

### 3.2 测试 Fixtures
```typescript
// fixtures/
// ├── keys/
// │   ├── ed25519 (valid)
// │   ├── ed25519-encrypted (passphrase)
// │   └── ed25519-expired
// ├── configs/
// │   ├── single-hop.json
// │   ├── multi-hop.json
// │   └── mixed-auth.json
// └── large-files/
//     ├── 1mb.bin
//     ├── 100mb.bin
//     └── 1gb.bin (sparse file)
```

## 四、CI/CD 集成

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build:test
      - run: npm test
        # 单元测试，不需要真实 SSH

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build:test
      - run: npm run test:integration
        # 集成测试，使用 mock SSH server

  performance-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build:test
      - run: npm run test:performance
      - uses: benchmark-action/github-action-benchmark@v1
        with:
          tool: 'console'
```

## 五、测试命令

```bash
# package.json scripts
{
  "test": "node --test dist/__tests__/*.test.js",
  "test:unit": "node --test dist/__tests__/*.test.js --test-name-pattern='^(?!Integration)'",
  "test:integration": "npm run build:test && node --test dist/__tests__/integration.test.js",
  "test:performance": "npm run build:test && node --test dist/__tests__/performance.test.js",
  "test:error": "npm run build:test && node --test dist/__tests__/error-handling.test.js",
  "test:all": "npm run build:test && npm test && npm run test:integration && npm run test:performance"
}
```

## 六、覆盖率目标

| 模块 | 覆盖率目标 |
|-----|----------|
| connection.ts | 90% |
| remote-tools.ts | 95% |
| file-transfer.ts | 85% |
| background-exec.ts | 85% |
| port-forwarding.ts | 85% |
| daemon.ts | 80% |
| mcp-server.ts | 80% |
| **整体** | **85%** |

## 七、实施计划

### Phase 1: 补充缺失单元测试 (2-3天)
- [x] multi-hop-auth.test.ts (已创建)
- [x] file-transfer.test.ts (已创建)
- [x] background-exec.test.ts (已创建)
- [x] port-forwarding.test.ts (已创建)
- [ ] **agent-auth.test.ts (新建)** - SSH Agent 和 Agent Forwarding 测试 (15+ cases)
- [ ] **mcp-server.test.ts (新建)** - MCP Server 21个工具完整测试 (30+ cases)
- [ ] **daemon-ipc.test.ts (新建)** - Daemon IPC 通信和集成测试 (20+ cases)
- [ ] **session-reuse.test.ts (新建)** - Session 复用和 Config Hash 测试 (10+ cases)

### Phase 2: 完善异常测试 (1-2天)
- [ ] **error-handling.test.ts (新建)** - 网络错误、认证错误、文件系统错误、资源限制、协议错误 (50+ cases)

### Phase 3: 添加性能测试 (1天)
- [ ] **performance.test.ts (新建)** - 大文件传输、多并发、内存监控 (25+ cases)

### Phase 4: CI/CD 集成 (0.5天)
- [ ] GitHub Actions 配置
- [ ] 覆盖率报告

### 预计总工作量: 5-6 天

---

## 八、现有测试改进建议

### connection.test.ts 改进
```typescript
// 当前只测试了空链和状态
// 需要增加：

describe("Multi-hop Authentication", () => {
  it("each hop can use different auth method", async () => {
    // Test: hop1 = password, hop2 = privateKey
  })
})
```

### integration.test.ts 改进
```typescript
// 当前测试了 2-hop，但都是相同认证
// 需要增加：

describe("2-hop Connection Chain", () => {
  // ... 现有测试

  it("hop1: password, hop2: privateKey", async () => {
    // 使用不同认证的多跳
  })

  it("3-hop with mixed auth", async () => {
    // hop1: password, hop2: privateKey, hop3: agent
  })
})
```

## 九、测试工具推荐

| 工具 | 用途 |
|-----|-----|
| Node.js built-in `node:test` | 单元/集成测试（已使用） |
| `tsx watch` | 开发时自动运行 |
| `@shopify/global-id` (benchmark) | 性能基准测试 |
| `leak-detector` | 内存泄漏检测 |
| `fast-check` | _property-based testing_ |

## 十、维护策略

1. **每次 PR 必须包含测试**
2. **测试命名规范**: `it("should [action] when [condition]")`
3. **测试隔离**: 每个测试独立，不依赖其他测试状态
4. **定期运行性能测试**: 监控性能退化
5. **Mock 外部依赖**: SSH 连接必须 mock，不依赖真实服务器
