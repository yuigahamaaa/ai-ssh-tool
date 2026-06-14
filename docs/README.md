# 文档索引

这目录里同时有当前使用指南、调度器设计、测试设计和历史评审记录。上手时优先读“当前文档”，历史文档只作为背景参考。

## 当前文档

| 文档 | 用途 |
|---|---|
| [AI_AGENT_USAGE.zh-CN.md](./AI_AGENT_USAGE.zh-CN.md) | 给 AI Agent 的最短使用 SOP：排队、等待、大输出、并发策略、虚拟 cwd。 |
| [AI_COLLABORATIVE_SCHEDULER_DESIGN.zh-CN.md](./AI_COLLABORATIVE_SCHEDULER_DESIGN.zh-CN.md) | 共享 VM 调度器完整中文设计。 |
| [SCHEDULER_IMPLEMENTATION_PLAN.zh-CN.md](./SCHEDULER_IMPLEMENTATION_PLAN.zh-CN.md) | 调度器实现方案和落地步骤。 |
| [SCHEDULER_TEST_DESIGN.zh-CN.md](./SCHEDULER_TEST_DESIGN.zh-CN.md) | 调度器测试设计。 |

## 英文/双语设计

| 文档 | 用途 |
|---|---|
| [AI_COLLABORATIVE_SCHEDULER_DESIGN.md](./AI_COLLABORATIVE_SCHEDULER_DESIGN.md) | 英文版调度器设计。 |

## 历史评审与测试记录

这些文件保留了设计过程中的问题、顾虑和测试审查。它们可能提到旧模块或早期方案，不一定代表当前最终结构。

| 文档 | 用途 |
|---|---|
| [SCHEDULER_REVIEW_NOTES.md](./SCHEDULER_REVIEW_NOTES.md) | 调度器方案早期顾虑和审查记录。 |
| [REVIEW.md](./REVIEW.md) | 代码审查记录。 |
| [REVIEW_OPTIMIZATION.md](./REVIEW_OPTIMIZATION.md) | 优化审查记录。 |
| [TEST_DESIGN.md](./TEST_DESIGN.md) | 早期测试设计。 |
| [TEST_REVIEW_20250601.md](./TEST_REVIEW_20250601.md) | 测试审查历史记录。 |
| [TEST_REVIEW_REPORT.md](./TEST_REVIEW_REPORT.md) | 测试审查报告。 |

## 当前架构提示

- 默认执行路径是 daemon 内的 `src/scheduler/`。
- MCP 和 CLI 都应通过 daemon scheduler，不各自维护队列。
- 调度相关 MCP 返回统一 JSON envelope：`ok`、`kind`、`data`、`agentGuidance`；`ssh_exec` / `ssh_schedule` 额外保留顶层 `action`、`taskId`、`result` 兼容旧用法。
- `src/background-exec.ts` 已移除；scheduler 已管理后台与前台 runner controller 的取消路径。`src/exec-task-manager.ts` 现在是 legacy facade：新任务交给 scheduler/`OutputStore` 管理，`~/.ssh-tool/exec-tasks` 只作老快照回退。
