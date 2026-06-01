# 代码审核报告

## 审核时间
2026-06-01

## 审核范围
核心模块：background-exec.ts, session-manager.ts, file-transfer.ts, remote-fs.ts

---

## 问题分析

### 1. 后台任务架构 - 断开进程后任务存活问题

**当前实现：**
- 任务存储在 `BackgroundExecManager` 的内存 `Map` 中
- 通过 `client.exec()` 在 SSH 会话中执行命令
- 使用 `echo $$; exec ${command}` 包装命令捕获远端 PID

**问题：**
- 如果本地进程断开（SSH 连接断开），远程任务会继续运行，但本地无法追踪状态
- 任务状态、输出都存储在内存中，进程重启后丢失
- 没有持久化机制，任务无法在会话间共享

**优化方案：**
1. 将任务状态持久化到远程服务器的文件系统
2. 使用 `nohup` 或 `disown` 确保任务在会话断开后继续运行
3. 提供任务 ID 和状态查询机制

---

### 2. 会话管理 - 多会话并发和 Profile 管理

**当前实现：**
- `SSHSessionManager` 支持多会话并发
- `maxSessions` 可配置（默认 50）
- 使用 UUID 作为 session key

**问题：**
- 没有按 profile 管理会话
- 没有使用 config hash 作为 key
- 无法快速复用相同配置的连接

**优化方案：**
1. 使用 config hash 作为 session key
2. 支持按 profile 名称/ID 管理会话
3. 添加会话复用检查（相同 config → 相同 session）

---

### 3. Profile 短名系统

**当前实现：**
- ProfileManager 支持按 ID 和名称查找
- 支持搜索和排序

**问题：**
- 没有短名别名系统
- 无法动态切换 profile

**优化方案：**
1. 添加 profile 别名（alias）字段
2. 支持 `use <alias>` 动态切换当前 profile
3. Tab 补全支持短名

---

### 4. CRLF 保护

**当前实现：**
- 文件传输没有任何 CRLF 处理
- 直接流式传输，不做转换

**问题：**
- Windows 和 Unix 系统行尾符不同（\r\n vs \n）
- 跨平台传输可能出现重复行或格式问题

**优化方案：**
1. 添加 `lineEnding` 选项：`auto` | `lf` | `crlf` | `binary`
2. 自动检测源文件行尾格式
3. 转换时保持文件完整性

---

### 5. Windows-Unix 编码转换

**当前实现：**
- 没有编码处理
- 使用二进制流传输

**问题：**
- GBK/GB2312（Windows 中文）和 UTF-8（Unix）互传会乱码
- 没有自动编码检测

**优化方案：**
1. 添加 `encoding` 选项：`auto` | `utf8` | `gbk` | `latin1`
2. 使用 `chardet` 自动检测编码
3. 转换时保持文件完整性

---

### 6. Setsid 回退机制

**当前实现：**
- 使用 `echo $$; exec ${command}` 包装命令
- 没有 setsid 支持

**问题：**
- 无法将进程完全脱离终端
- 会话断开可能影响后台任务

**优化方案：**
1. 尝试使用 `setsid` 创建新会话
2. 回退到 `nohup` 或 `disown`
3. 检测环境支持情况，智能选择

---

### 7. Sigkill 处理

**当前实现：**
- `cancel()` 方法使用 `kill -TERM` 然后 `kill -9`
- 没有 graceful shutdown

**问题：**
- 立即杀死进程，无法执行清理
- 没有 trap 处理

**优化方案：**
1. 添加 SIGTERM → 等待 → SIGKILL 的超时机制
2. 支持在远程命令中注入 trap 处理
3. 记录进程终止原因和清理操作

---

### 8. 小文件传输优化

**当前实现：**
- 所有文件都使用流式传输（createReadStream/createWriteStream）
- 即使是几 KB 的小文件也创建流

**问题：**
- 小文件流式传输开销大
- 多次 syscall 调用

**优化方案：**
1. 添加 `fileSizeThreshold` 选项（默认 10MB）
2. 小于阈值的文件使用 `fs.readFile/writeFile`
3. 大于阈值使用流式传输

---

### 9. Symlink 跳过

**当前实现：**
- 文件夹传输使用 tar，自动保留 symlink
- 没有跳过选项

**问题：**
- symlink 可能导致循环或权限问题
- 某些场景需要跳过

**优化方案：**
1. 添加 `followSymlinks` 选项
2. 添加 `skipSymlinks` 选项
3. 记录跳过的 symlink 列表

---

### 10. Overwrite 控制

**当前实现：**
- `FolderTransferOptions` 有 `overwrite` 布尔值
- 简陋，不够灵活

**问题：**
- 无法选择性覆盖
- 无法重命名冲突文件

**优化方案：**
1. 支持 `OverwriteStrategy`：`ask` | `skip` | `overwrite` | `rename` | `backup`
2. 添加 `conflictHandler` 回调函数
3. 详细记录每个文件的处理结果

---

## 优化优先级

### P0 - 必须修复
1. 后台任务持久化
2. 会话管理按 profile hash
3. Overwrite 控制策略

### P1 - 高优先级
4. Profile 短名系统
5. CRLF 保护
6. 小文件传输优化

### P2 - 中优先级
7. Setsid 回退
8. Sigkill 处理改进
9. Symlink 跳过
10. 编码转换

---

## 测试覆盖

需要添加的测试：
- [ ] 后台任务持久化测试
- [ ] 会话复用测试
- [ ] Profile 短名查找测试
- [ ] CRLF 转换测试
- [ ] 编码检测测试
- [ ] Setsid 回退测试
- [ ] Sigkill 信号处理测试
- [ ] 小文件优化测试
- [ ] Symlink 跳过测试
- [ ] Overwrite 策略测试
