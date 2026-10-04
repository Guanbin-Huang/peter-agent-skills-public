# Preview 验收与完整版本合入

## 使用者动作

看修改（页内单片段）→ 通过并应用 / 继续修改 → 后台合成 → 播放完整新版。
“标为已解决”不等于验收某个产物。接受必须绑定 markerId + revisionId，记录原批注、提交、具体产物、处理说明和 approvedAt。不要代用户点击接受；测试在副本中进行。

## 当前实现

- `preview_apply.js` 管理候选、显式验收、不可变记录、单合成队列及版本。
- `preview_apply_render.js` 实现新增视觉效果的确定性合入：原基准全片 + 已通过的增量 ASS，原音轨 copy。全帧 PTS、音频逐包内容与时点、全量解码通过才发布。
- `GET /api/edit-application` 返回逐 marker 候选、验收状态、实际渲染帧进度和完整版本。
- `POST /api/edit-accept` 接收 `{markerId,revisionId}`；`POST /api/edit-retry` 重试失败合成。复用当前回调令牌，接受不写 resolved。
- 同一个 `group` 的新旧效果互斥；新版本接受时替代旧版本，不叠加。旧记录保留。

局部 worker 对视觉新增效果在 result.items[].apply 返回：

```json
{"mode":"ass_overlay","audio":"unchanged","assFile":"/绝对路径/仅本条新增效果.ass","group":"同一修改位置的稳定组名","fontsDir":"/字体目录"}
```

ASS 仅含 header/styles 和本条新增 Dialogue；时间是原始完整 Preview 轴。inputPreview 与批次冻结的 basePreviewSha256 必须匹配；不能把基准字幕再次烧入。旧结果可通过 `preview_apply_specs.json` 显式关联，不改不可变原提交。

当前自动合入器只接受已验证的 visual-only 增量方案；涉及删除、顺序、变速、替换基准字幕的修改需源 EDL 方案，不得伪装为 overlay 或用低清 review 硬拼。原有源 EDL 渲染器保留，不给缺少合入方案的记录展示可用的验收按钮。

## 流水线与播放

局部结果优先返回供快速审核；接受后后台生成完整文件，期间用户继续批注。正在合成时的新接受只推进最新目标集合，不逐条堆积重复全片任务。每轮都从同一原基准生成，不在上一轮烧录版本继续叠。

浏览器轮询不换媒体。显式「播放完整新版」才切换，保持播放位置/速度/试剪；失败恢复旧媒体。对于当前 identityTimeline 方案，新旧时长一致，原片坐标不变。完整合入预览不代表全片所有内容已经验收。

## 记录与复盘

- `preview_apply_state.json`：当前通过集合及版本。
- `preview_apply/events.jsonl`：接受、失效、替换、合成成功/失败的追加记录。
- `preview_apply/versions/<id>/manifest.json`：本轮不可变验收快照和效果副本。
- 同目录 `verification.json` 与 `full.mp4`：完整验收证据与版本化媒体。

`build_preview_retrospective.js` 同时收集这些验收记录。判断偏好时区分用户提出、实际修改、技术验证和用户通过；保存 Edit 不代表自动固化为长期规则。
