# AI剪口播四核心 sub-skill 编排 v1

模型与推理强度、子任务写入范围、并发上限统一读取 [任务模型与并行路由-v1.md](任务模型与并行路由-v1.md)。以下内容定义业务依赖，不表示四路都需要相同模型或同时运行。

## 职责边界

1. `douyin-rough-cut` 是唯一 EDL 写入者，产出 `rough_cut_manifest.json`、`sourceKeeps`、`fineKeeps`、speed manifest、canonical transcript、final word timings 和同步 QA。
2. `xiaolan-broll` 只读上游 SHA，产出 `broll_manifest.json`、`role_chip_manifest.json`、代表性样片与视觉 QA；不得改 EDL。
3. `douyin-cover` 只读干净 A-roll、timelineMap、总控已冻结的 atomic-units 与已确认标题，产出各比例封面和 `cover_manifest.json`；不得从带字幕/B-roll 的 Preview 截图。
4. `douyin-captions` 只读 canonical transcript、final word timings、hard boundaries 与总控已冻结的 atomic-units，产出 SRT/ASS/timing/字幕 QA，并向封面共享得意黑资产契约；它不得在并行阶段另生成第二份词表。
5. `AI剪口播` 负责在 fan-out 前调用字幕原子词提取器冻结唯一 `atomic-units.txt`，再汇合上述 manifest、服务 HTML Preview、管理批注，并且只有汇合验收通过后才原子发布 `active_release`。

## 剪辑前只读决策闸门

收到逐字稿和视频后，总控先做媒体探测、WhisperX 抽样、角色/素材映射和 take 分组候选，自主判断 `single_talking_head`、`dual_role_dialogue` 或 `multi_person_interview`，再给用户一张带推荐的剪辑启动卡。用户回复“按推荐”或明确改选项后，`preedit_decision.json.status` 才从 `awaiting_user_choice` 变为 `confirmed`；此前任何分支都不得写 EDL 或渲染正式粗剪。

启动卡同时确认 `broll.mode=none|light|structured` 和 `role_chips.enabled`。二者独立：`broll.enabled=false` 不得自动关闭双角色人物贴片。用户没有开启 B-roll 时，不启动 B-roll 分支；轻量或结构化模式都先交 3–5 个代表性样片。

## 串行前置

素材/ASR 只读判断 → 用户确认剪辑启动卡 → 角色和最后一次完整正确 take → `douyin-rough-cut` 唯一 content EDL → 气口 0.30–0.40 秒且 <=0.5 秒 → 1.3x 一次 → 吞字/字幕文本/音画同步门禁 → 冻结不可变 `upstream_bundle` SHA。

任何正文、时长、倍速或 timing 变化都会使三个视觉分支的旧结果失效。

## 并行批次

总控在 canonical transcript 上先冻结共享 `atomic-units.txt`；完成这道 fan-out gate 后才可同时运行：

- `douyin-captions`：字幕纠错、读取共享 atomic-units、断句、样式和 timing。
- `douyin-cover`：从干净 A-roll 选帧，读取同一份 atomic-units 做标题断句，并输出 9:16/3:4/4:3 无黑边封面。
- `xiaolan-broll`：只在 `broll.mode=light|structured` 时先做 3–5 个代表性 B-roll 样片；人物贴片读取独立的 `role_chips.enabled`，因此 B-roll 关闭时仍可制作人物贴片。样片未确认时主时间线保持无 B-roll。

每个分支写独立目录与 manifest；不得覆盖其他分支或共享 EDL。

## 汇合验收

1. 校验三个分支引用的 EDL/media/speed/timing SHA 与 `upstream_bundle` 一致。
2. 检查字幕、人物贴片、B-roll 与封面安全区和字体资源。
3. 生成低清 HTML Preview，验证实际媒体 Range 与 SHA。
4. 用户确认后只从干净原片一次生成高清版本；全部汇合验收通过后才原子切换 `active_release`，最后完整解码、源相对时序、音画同步和平台封面无黑边验收。
