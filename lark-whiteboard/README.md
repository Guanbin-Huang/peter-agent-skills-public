# Lark Whiteboard｜飞书画板

在飞书云文档中创建、查询与编辑可编辑画板。支持思维导图、流程图、架构图、组织图、时序图等；根据图表类型选择 Mermaid、SVG 或 DSL，并在写入前本地渲染审查，写入后从飞书回读确认。

- [Skill 入口](SKILL.md)
- [思维导图 / Mermaid 路径](routes/mermaid.md)
- [SVG 路径](routes/svg.md)
- [DSL 路径](routes/dsl.md)

## 安装与依赖

复制本目录到 Agent 的 skills 目录，例如 `~/.codex/skills/lark-whiteboard`。本目录保留本机已有技能内容与配套参考资料，不包含账号配置、凭据或私人画板数据。

使用前需安装并配置 `lark-cli`，完成用户授权；安装与认证按飞书 CLI 官方说明操作。另需 Node.js / npm，以运行 `npx -y @larksuite/whiteboard-cli@^0.2.11`。

本技能引用同级的 `lark-shared`（认证与权限）及 `lark-doc`（创建文档、插入画板与回读）。请同时安装飞书 CLI 配套的这两个 Skill；它们不是本目录内置文件。

## 调用示例

```text
使用 lark-whiteboard，把下面的知识点整理成飞书思维导图。
先按概念层级分类，说明各部分的关系，保留原始数字；
写入飞书可编辑画板，回读确认节点完整后返回文档链接。
材料：【粘贴材料】
```

原技能 frontmatter 的版本、名称及参考文档保持不变。
