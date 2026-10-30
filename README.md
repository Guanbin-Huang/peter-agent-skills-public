# Peter Agent Skills｜公开版

这里收录已经确认可公开的 Agent Skills。

## AI剪口播

[查看 Skill 与使用说明](AI剪口播/README.md) · [Skill 入口](AI剪口播/SKILL.md)

![AI剪口播工作流](AI剪口播/assets/workflow.png)

支持日常轻剪、完整制作、网页批注审核、局部返修与高清交付。配套 skill 和服务依赖见技能 README，按实际启用路径配置。

### 最新同步｜2026-10-30

默认音画速度统一为 **1.2×（仅一次）**，过长普通气口保留约 **0.30 秒**；新增自主选题与多题拆分、柔和镜头跟随、项目 JSON 字幕包装，以及按要求联动画面/原声/字幕的人名脱敏规则。配套新增模板包装脚本与测试，并修复网页视频审核的尾部字节请求。

[查看本次更新明细：原先与现在的变化](AI剪口播/README.md#updates-2026-10-30)。工作流规则与实际新增工具在明细中分列。

安装时复制 AI剪口播 目录到 coding agent 的 skills 目录。

每个技能保留自己的许可；AI剪口播 沿用 AGPL-3.0 与原作者署名。

## Peter Expression｜简历写作与项目表达

[独立求职仓库](https://github.com/Guanbin-Huang/antiboomer-jobseeking-skill) · [查看功能与用法](https://github.com/Guanbin-Huang/antiboomer-jobseeking-skill/blob/main/README.md) · [Skill 入口](https://github.com/Guanbin-Huang/antiboomer-jobseeking-skill/blob/main/SKILL.md)

![Peter Expression 功能与用法](https://raw.githubusercontent.com/Guanbin-Huang/antiboomer-jobseeking-skill/main/assets/workflow.png)

两大功能：**简历怎么写**（融合 ASu 的岗位匹配与经历重组），以及 **逐字稿＋项目文档**。共用事实底稿与 Agent/具身智能领域路由，保留 ASu 来源和 MIT 许可。

Peter Expression 的唯一维护源是独立仓库 `antiboomer-jobseeking-skill`；本仓库的 `peter-ai-interview-expression/` 是 Git submodule 索引，不维护重复副本。

```bash
git clone --recurse-submodules https://github.com/Guanbin-Huang/peter-agent-skills-public.git
# 已克隆总仓库时：
git submodule update --init --recursive
```

安装时复制展开后的 `peter-ai-interview-expression` 目录到 coding agent 的 skills 目录。协作者在独立求职仓库提交；独立仓库更新后，总仓库需另行提交 submodule 版本指针。

## Feishu Course｜从会议到课程

[独立仓库](https://github.com/Guanbin-Huang/feishu-course-from-meetings) · [功能与安装](https://github.com/Guanbin-Huang/feishu-course-from-meetings/blob/main/README.md) · [Skill 入口](https://github.com/Guanbin-Huang/feishu-course-from-meetings/blob/main/SKILL.md)

![Feishu Course：逐字稿与视频画面双路融合](https://raw.githubusercontent.com/Guanbin-Huang/feishu-course-from-meetings/main/assets/workflow.png)

同时读取飞书课堂的完整逐字稿与视频画面：识别 PPT、白板、代码与操作演示，按时间对齐教学证据，再组织跨课主线、课程地图、逐讲笔记和练习。课程附关键画面说明、原稿与带时间的回看入口；记录实际阅读范围和待补画面，写入后回读正文与权限。已有课程依据清单处理新增课堂，保留原链接与手工内容。

`feishu-course-from-meetings/` 是指向独立仓库的 Git submodule；公开版本在独立仓库维护，本仓库只提交版本指针。安装时使用上面的递归克隆命令，或直接克隆独立仓库到 `~/.codex/skills/feishu-course-from-meetings`。飞书 CLI 与配套 Skill 依赖见独立仓库 README。
