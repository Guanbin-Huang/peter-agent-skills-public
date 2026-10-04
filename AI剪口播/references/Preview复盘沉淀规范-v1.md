# Preview 复盘与剪辑偏好沉淀规范 v1

## 触发

用户说“复盘一下剪辑”“复盘剪辑”“学一下我的剪辑偏好”或“把这次批注沉淀到 skill”时执行。该触发表示开始证据复盘，不代表可以把每条批注直接写成长期规则。

## 1. 主机与项目闸门

1. 先确认任务实际运行主机。用户从 Mac Air 输入，不代表文件在 Air；`Desktop · Mac mini` 任务直接读取 Mini。
2. 当前任务不在 Mac mini 时，先通过已配置的 SSH/远程工作区验证项目路径可读：优先 SSH 别名 `mini`，连接失败或超时则使用 `mini-aliyun`。网页能打开不等于本地任务能读 Mini 文件。
3. 项目定位优先级：用户明确路径或名称 > 当前工作区 > 当前 Preview 服务配置 > 唯一的最新提交快照。
4. 存在多个候选且无法唯一判断时，只问项目名；不得要求用户重新复制批注。

## 2. 冻结复盘证据

先运行：

```bash
node "$SKILL_DIR/scripts/build_preview_retrospective.js" \
  "/path/to/project" \
  "/path/to/project/preview_retrospective_evidence.json"
```

复盘输入按可信度分层：

1. **用户意图**：`codex_runs/<submissionId>/comments.json`；旧项目读取 `codex_callback_comments_<submissionId>.json`。
2. **提交时状态**：同次提交的 `timeline.json`、`prompt.md`、Preview→原片映射和 `preview_edit_packets.json`。
3. **真实执行**：`events.jsonl`、`result.json`、EDL/plan、输出视频和 QA 结果。
4. **用户验收**：新版 Preview 的审核结果、已解决状态，以及用户明确说“通过/可以/按这个沉淀”的记录。

活动文件 `preview_comments.json` 只代表当前草稿。优先使用不可变提交快照；不得读取或输出 `codex_callback_config.json` 的 token。

### 外部手剪成片（只有 MP4，没有工程）

1. 冻结用户成片与实际 AI 基准版本的路径、SHA、时长；当前工作区或用户明确给出的原始文件是证据，不用浏览器缓存冒充项目。远端检查失败时记录待同步，不把本地证据说成 Mini 验收。
2. 用音频对应关系和同内容画面建立跨版本映射，局部复核插入、删除、重排及变速边界；报告覆盖范围和不确定性，不按相同秒数截图、总时长差或 ASR 文本 diff 直接推断剪法。
3. 分列新增、删除、未变、未确定，再用台词上下文解释信息贡献。全文 ASR 漏词时，用切点附近原声、局部转录与音画映射复核；转录缺字不自动等于人工删词。
4. 沿用的字幕、镜像、倍速只记为未变；参考成片不等于逐项验收全部继承设置。没有工程时不伪造工程 EDL、网页 submission 或 accepted 状态。
5. 用户明确要求按手剪成片沉淀时，把可验证的取舍写成有适用条件的规则；具体彩条/音效样式和时长只留项目案例，不自动变成每条必加。已有覆盖标 existing-covered，未改领域不硬造新偏好。

## 3. 四态判断

每条批注分别标注：

- `proposed`：用户提出了修改。
- `executed`：结果文件或 EDL 证明实际执行。
- `verified`：解码、音画、关键帧或其他 QA 通过。
- `accepted`：用户通过新版或明确确认该规则。

状态文件与产物冲突时，不只相信 `state`。例如状态仍为 `running`，但日志已经结束且新版存在，应报告不一致并继续核验进程、日志退出和成片；未能闭环时不得标为 `accepted`。

## 4. 哪些能沉淀

满足至少一项才生成长期候选：

- 用户明确写成全局偏好。
- 同类反馈在一个或多个项目中重复出现至少两次。
- 用户明确确认某项处理“以后都这样”。

以下内容不得直接沉淀：

- 只针对某个画面的“这里删掉”。
- 失败、仍在运行或没有真实产物的执行。
- 尚未验收的 agent 推断。
- 已被现有 skill 完整覆盖的同义规则；这类标为 `existing-covered`。

把可泛化意图写成条件规则，不记录视频专有时间点。例如“后面没有紧接的新元素时，B-roll 完整状态保持到当前句子结束”可以沉淀；“删掉 04:30 的图”不可以。

## 5. 路由到 canonical skill

| 偏好领域 | 目标 skill |
| --- | --- |
| 总控、唯一 release、HTML 审核和版本汇合 | `AI剪口播` |
| take 选择、内容删冗、气口、1.3x、切点和音画同步 | `douyin-rough-cut`（内部调用 `clip-fine-cut-rhythm`） |
| B-roll 选材、人物贴片、触发、动画、密度和停留 | `xiaolan-broll` |
| 封面选帧、标题断句、字体、多比例无黑边 | `douyin-cover` |
| 字幕断句、字号、字体、阴影、位置和 timing | `douyin-captions` |

跨领域规则拆开处理。更新前先读目标 skill 全文并去重；使用 `codex-skill-creator` 检查 canonical 路径，再用“达尔文 skill”逐个验证。不得创建近似重复 skill。

## 6. 项目复盘报告

在项目中写 `editing_retro_<submissionId>.json`，至少包含：

- 项目、主机、`submissionId` 和生成时间。
- 每条 marker 的四态、证据文件及 SHA-256。
- 候选规则、是否已有覆盖、目标 skill。
- 最终沉淀规则、skill diff 和验证命令。
- 未沉淀项及原因。

报告不保存 token、API key 或完整敏感配置。完成后向用户简要报告：读到几次提交、几条批注、沉淀几条、分别进入哪个 skill、哪些因证据不足未写入。

## 7. 跨设备验收

修改发生在 Mac mini 时，`Desktop · Mac mini` 后续任务立即读取 Mini 的 canonical skill。要让 Mac Air 本地任务也生效，必须把变更安全合并到 Air 的 `~/.codex/skills`，并比较目标文件 SHA-256；只看到网页或仅复制视频不算同步完成。
