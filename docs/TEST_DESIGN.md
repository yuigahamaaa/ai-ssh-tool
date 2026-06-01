# 测试设计文档

## 1. 测试范围

### 1.1 背景任务管理（background-exec.ts）
- 启动任务
- 查询任务状态
- 获取任务输出
- 取消任务
- 持久化任务（setsid + nohup）
- SIGKILL 回退机制

### 1.2 文件传输（file-transfer.ts）
- 小文件直接上传/下载
- 大文件流式传输
- 编码转换（utf8/gbk/latin1）
- 换行符转换（lf/crlf/auto）
- Overwrite 策略（skip/backup/rename/overwrite）
- 符号链接跳过/跟随
- 文件夹压缩传输
- 权限保留

## 2. 测试策略

### 2.1 单元测试
- 使用 Node.js 内置 `node:test` 框架
- 模拟 SSH 服务器（ssh2.Server）
- 内存文件系统用于测试
- 独立运行，不依赖实际服务器

### 2.2 集成测试
- 使用本地 Docker 容器作为测试 SSH 服务器
- 测试真实场景
- 包含持久化任务和大文件传输

## 3. 测试环境准备

### 3.1 依赖安装
```bash
npm install
```

### 3.2 本地测试容器
```bash
# 启动测试 SSH 服务器（可选）
docker run -d -p 2222:22 -e USER=test -e PASS=test123 rastasheep/ubuntu-sshd
```

## 4. 测试分组

### 4.1 快速测试（test:fast）
所有不依赖外部容器的测试，用于日常开发和 CI：
- session-manager
- profile-manager
- logger
- remote-tools
- connection
- gateway
- error-handling
- mcp-server

### 4.2 慢速测试（test:slow）
依赖后台生命周期的测试：
- daemon-lifecycle

### 4.3 集成测试（test:integration）
完整的用户场景测试：
- 跳板机连接
- 大文件传输
- 后台任务管理
- MCP 协议

## 5. 新增测试计划

### 5.1 background-exec 新增测试
- ✅ cancel 功能是否真的发送 kill 信号
- ✅ persistent 模式是否真的使用 setsid + nohup
- ✅ SIGTERM 超时后是否回退到 SIGKILL

### 5.2 file-transfer 新增测试
- ✅ 小文件编码转换
- ✅ 小文件换行符转换
- ✅ 流式传输的转换
- ✅ 各种 overwrite 策略
- ✅ 符号链接跳过/跟随
- ✅ 权限保留
- ✅ 文件夹传输

## 6. 运行测试

```bash
# 所有测试
npm run test

# 快速测试
npm run test:fast

# 特定文件
npm run build:test && node --test dist/__tests__/file-transfer.test.js
```
