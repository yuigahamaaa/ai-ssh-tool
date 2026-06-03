# SSH Profile 配置目录

此目录用于存放 SSH 连接配置文件（Profile）。

## 使用方式

将 `.json` 配置文件放在此目录，即可通过 `profile_name` 引用。

### 配置文件格式

```json
{
  "name": "my-server",
  "alias": "ms",
  "chain": [
    {
      "host": "192.168.1.100",
      "port": 22,
      "username": "root",
      "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
    }
  ],
  "tags": ["测试"]
}
```

### 引用方式

1. `profile_name: "my-server"` — 按文件名/别名搜索
2. `profile_file: "profiles/my-server.json"` — 直接传路径

## 安全提醒

⚠️ 此目录可能包含敏感信息（私钥/密码），请勿提交到 Git！

.gitkeep 用于保留目录结构。
