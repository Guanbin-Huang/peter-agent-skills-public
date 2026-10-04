---
name: AI剪口播
description: 支持已确认逻辑的日常轻剪：只剪气口、保留大笑、日常1.1×、9:16竖版与封面并行。也支持本地 WhisperX 转录、词级对齐与 pyannote 说话人分段、口播视频转录、多段手机素材初检、按逐字稿逻辑粗拼、口误与现场对话清理、带规范字幕的低清 HTML 审核循环、一键回调 Codex 精剪、每保存两条 comment 自动修改、结尾单条自动处理、逐块返修审核、剪辑复盘偏好沉淀和最终成片包装。逐字稿是逻辑地图，不要求实拍逐字一致；以真实 ASR 和原声为内容依据。初检完成后直接把带字幕低清 Preview 装进 HTML，不单独设置或交付 Rough Preview 阶段；用户明确说“无字幕”时才跳过。模式 C 必须先调用 douyin-rough-cut 冻结唯一粗剪/气口/变速/同步时间线，再并行调用 xiaolan-broll、douyin-cover、douyin-captions，最后由本 skill 汇合 HTML Preview 和正式成片。触发词：找已剪视频、找回成品、我要的是成品视频、双人对谈、两个人聊天、双人访谈、按那三条的方法剪、后处理、剪口播、手机录了几段、多个视频、逐字稿、初检、粗剪、现场对话、删除指令、Preview 批注、已审到这里、comment 自动处理、边看边剪、视频打点、M 键标记、视频评论、提交给 Codex 精剪、一键回调、逐块审核、返修片段、流程一、流程二、完整 Preview、复盘一下剪辑、复盘剪辑、学一下我的剪辑偏好、沉淀剪辑偏好、最终成片、输出最终产品、输出成品、抖音版、视频号版、短视频字幕、加标题、加片尾、返回视频、压缩视频
metadata:
  category: media-video
  status: canonical
  canonical_root: ~/.codex/skills
  related_skills:
    - douyin-rough-cut
    - xiaolan-broll
    - douyin-cover
    - douyin-captions
    - video-quick-revision
---

## 提速入口：质量不减，命中后短路（2026-10-04）

每次调用先按本轮请求命中找回、日常轻剪、局部返修、冻结工程导出、新片或平台操作，只运行该分支及必要依赖；遇到流程冲突、用户要求提速或复盘时，再读 [质量不减的提速路由](references/质量不减的提速路由-v1.md) 的失效与验收表；不把后文通用四核心全流程叠加到已命中的轻量路径。保留内容、笑声、完整发音、同源同步、字幕和画质门槛，通过复用、阶段恢复及减少模型往返提速，不以省验收或降低规格提速。

## 已剪成品找回与直接交付（2026-10-04）

用户说“有没有剪过这个视频”“找回成品”“我要的是成品视频”且指向既有视频时，先走只读召回，不进入新剪辑或高清重建。此路由优先于后文“返回视频/输出成品”的制作规则；明确要求新导出、改字幕、改封面或重新剪辑时才回到对应制作/返修流程。

1. 复用当前会话已确认路径；首次查找先检索 `~/AgentsDockOutputs` 的项目标题记录（如 `*/cover/manifest.json`、剪辑摘要），再查项目字幕/SRT，以用户原词为主。标题未命中时查字幕；两个入口均未命中才扩大到记忆提示的素材库、Documents 或历史记录。不要先猜词、先扫整库或因相似父母主题认定是同一条。
2. 用验收/交付记录确认最新高清成品，再做一次文件存在性/大小检查。不能只凭 `MODIFIED_FILE.mp4`、final 等文件名判定成品；多个版本依据最新修改及验收记录选择。有效证据覆盖且文件未变化时直接复用；未覆盖、文件变化或版本有冲突时只补缺失核验。查询定位完成立即停止，不启动 ASR、重剪、渲染、服务诊断或模型候选选择。
3. 用户要成品时直接交付高清 MP4，不用预览版或仅本机路径代替。在 AgentsDock 使用当轮发布 CLI/当前 chat-id 附上视频，只有成功 JSON 回执才说“已附上”。其他环境使用当轮支持的附件入口。发布报错时保留真实错误，继续核对既有播放/下载入口；不重剪来解决附件错误。
4. 用户只问“在哪里/是否剪过”时返回文件位置和确认状态；用户要在线看/批注时返回已核验的播放/审核入口，不默认发布大附件。没有唯一成品时列候选或询问一个关键区别，不把原片、Preview 或草稿称作成品。只报已确认的版本/规格，不声称平台已发布。

最小验收：主题原话命中、最新成品证据、文件可读；成品附件需求另需发布成功回执。记录检索和附件提交阶段耗时，不把毫秒级工具耗时冒充整轮响应耗时。本路径不改变时间线、速度、字幕、封面或片尾。

## 日常／已确认逻辑：轻量剪气口（2026-10-03 用户确认）

先读 [日常轻量剪辑协议](references/日常轻量剪辑-v1.md)。命中轻量模式后只读该协议与本次实际启用的工具入口；不继续加载完整导演编排、全模型矩阵、ASR/说话人分段手册等未启用流程。用户说“日常版／简单剪剪／逻辑已经 OK／按我给的逻辑剪／只剪口播气口”时，使用 `edit_mode=lightweight-breath`：保留原顺序和完整正文，极力保留大笑、吸气、表情及戏剧性反应；常规无内容气口在**输出时间线尽量 ≤0.30 秒**。日常版音画同步 **1.1×**，非日常速度不因本规则改动。抖音／视频号默认 **1080×1920、9:16竖版**，主封面也是9:16。

正文快速剪气口与封面选帧/排字独立并行，最终合入前三帧时才汇合；已给标题、速度与格式直接继承。优先现成快速剪气口链路，不把此模式升级为内容重排、全片双模型ASR、多轮判断、未请求的字幕/片尾/B-roll或重复审批。已有字幕保留；局部边界疑问只复核局部。本节优先于后文完整粗剪/包装、旧气口目标、通用1.3×与“冻结EDL后才开始封面”的表述；只覆盖轻量任务的流程，所有视频的笑声保护始终适用。

## 判断与选择默认必跑 StartLux（2026-10-02）

本 skill 的分类、比较和候选选择必须先按 [StartLux 视频判断协议](../startlux-decision/references/video-selection-v1.md) 调用真实模型，不再等用户逐次点名。`edits` 做类别路由，`choices` 做素材/结构/切点/字幕/封面/B-roll 候选选择；Codex 整理带源ID/时间码的文字证据并复核执行。已明确的用户参数与确定性操作直接继承/由脚本完成。保存本项目决策回执；没有成功回执的判断保持待判，不用 GPT 结果冒充 StartLux。此条优先于下文旧的模型选择条款，其他时间线和验收门禁不变。


# 剪口播 

> 本地 WhisperX 转录 / 词级对齐 / 说话人分段 + 按任务选模型 + 网页审核 / 可编辑字幕工程

## 交付入口匹配用户设备（2026-10-02 明确纠正）

先读取实际消息来源或用户当前声明，不把 Mac 执行主机当成用户终端。**手机/iPhone/AgentsDock 手机消息 → 交付手机 Chrome 可打开的、已验收的带鉴权公网 HTTPS Web Preview；不得交 localhost/127.0.0.1、仅本机路径，也不得打开 Mac 浏览器冒充手机交付。电脑消息 → 可以使用该电脑能访问的 localhost。** 当前明确指定的浏览器/远程入口优先；手机 Chrome 覆盖旧 Safari 默认。消息来源未知时不得猜电脑，优先可跨设备的 HTTPS，必要时只问正在用哪台设备。

手机入口交付前验证公网页面、实际视频字节/Range、手机尺寸播放与触屏批注保存/回读；保留原版 Review 功能，不擅自改成另一个 iOS App。手机没有键盘时给可点击的“添加批注”入口，不仅交 M 键说明。本地剪辑/批注与公网交付是不同状态，只有手机可访问入口回读通过后才报告已交付。

## B-roll 默认风格路由（2026-10-01）

B-roll 已确认启用且用户未给其他风格时，调用 `xiaolan-broll` 内的 **口播知识结构风**（`broll.style=knowledge-structure`）。触发词：`口播知识结构风`、`知识结构风`、`知识结构 B-roll`、`拿 offer 那套 B-roll`；执行前读取其 `references/口播知识结构风-v1.md` 和 JSON preset。此路由不自动开启 B-roll，不跳过样片门禁，不改 EDL/倍速/字幕，人物贴片仍独立。交付按上节用户当前设备与浏览器选择 Preview 网页链接，不默认让用户下载 AgentsDock 视频附件；链接必须经过实际回读。

## StartLux 判断与选择（默认必跑）

所有需要分类、比较或在候选中选择的节点，按 [共享协议](../startlux-decision/references/video-selection-v1.md) 执行真实 `edits` / `choices`。新素材先做形式、主线和顺序候选判断；批注、字幕、封面等由各子 skill 在其判断节点调用。同一模型/输入/源版本的成功回执可复用，不重复分类同一份输入；机械工作继续走脚本。重要删留/结构由 Codex 准备有证据的候选，StartLux 选择，Codex 复核并由唯一 owner 改 EDL。StartLux 故障时相关判断保持待判并报告真实错误，不静默切回原模型。

## 模式

- **模式 A: 剪口播** — 转录 → 口误识别 → 网页审核 → 剪辑
- **模式 B: 转字幕** — 转录 → 格式化字幕文本（markdown，无时间戳）
- **模式 C: 多段手机口播 Preview→成片** — `douyin-rough-cut` 粗剪/气口/1.3x/同步 → `xiaolan-broll`、`douyin-cover`、`douyin-captions` 并行 → HTML 审核 → 最终高清
- **成片包装 subset** — 在 `douyin-rough-cut` 冻结 `fineKeeps` 与 speed manifest 后执行：封面/字幕/B-roll 汇合 → 片尾 → 验证

## 视频附聊天记录：默认上人下聊天

用户在视频任务附聊天截图/记录时，自动将 `visual_profile=chat-split-screen-v1`、`chat_layout.enabled=true` 交给 `xiaolan-broll` 的已确认模板：人物上区、聊天下区约各半屏，字幕在人物下巴下面，聊天卡片保持可读与既有打码。无需重复让用户选这个布局；不因此开启结构化 B-roll、改正文、变速或加音乐。仅阅读/总结聊天记录不触发视频制作；当前明确指定其他 layout 时覆盖。字幕 owner 读取人物/聊天分区 bbox，禁止默认字幕覆盖下区聊天。封面前三帧、最新视频目录和预览交付规则保持。

## 有聊天/B-roll 时优化人物头顶空白

用户要求有聊天记录或已启用 B-roll 的人物视频快速裁掉大片无效头顶空白。调用 `xiaolan-broll` 的头顶空白检测模板：少量抽帧、原生 Vision、均值候选加最高头顶/手势保护线；保护头发/眼睛/下巴，从干净底片裁切后重排视觉层，不裁烧字成片、不硬编码坐标、不逐帧模型判断。封面底图复用这个构图判断；人物聊天分区、原声、时序和封面前三帧规则保持。不因优化空白自动开启 B-roll。

## 简单修改优先走视频轻量返修

用户于 2026-10-01 明确要求将简单改字、改字母、挪字幕等快速处理沉淀成子 skill。命中此类小改动时，先调用 `video-quick-revision`（`~/.codex/skills/video-quick-revision/SKILL.md`）：脚本优先；需要局部判断才用 `gpt-6-luna` low/medium，复用时间线、音轨、字幕和检查，只验证改动处并返回新版。该流程优先于完整新片流程与通用倍速默认，不为小改动新增 ASR、重剪、再变速或多代理步骤。它是返修流程子 skill，不更换四核心领域 skill 的职责。

## 可编辑交付与按需模型分工

用户于 2026-09-25 确认采用“可编辑工程 + 发布 MP4”的交付方式。开始新项目、工程交接或仅改字幕文字时，先读取 [references/可编辑工程与按需模型分工-v1.md](references/可编辑工程与按需模型分工-v1.md)。

- 原生剪映草稿须有独立字幕轨并保存重开验收；干净底片 + 时间线 + SRT/ASS 的可编辑素材包须明确标注，不冒充已经导入剪映的工程。MP4 只作为发布产物。
- **仅改字优先走轻量返修**：冻结最新已验收时间线与音轨，用 `scripts/patch_caption_text.py` 在新目录输出字幕修订；不重跑 ASR、不重剪、不再次变速。工具只修改字幕资产，不代表烧录视频或剪映草稿已更新。核对修改页及相邻边界后再渲染受影响缓存段。
- 字幕文字未改变 timing、EDL 或音频时，复用这些项目的有效验证；本分支优先于后文完整新片流程，不因改一个字触发整片转录或内容审核。音画时序变化则回到相应领域验收。
- 每个具体任务的完整模型 ID（含 GPT-6.1）与推理强度，统一读取下节路由表；不得把“Sol medium/high”当成最终分工。小任务直接执行，不为替一个词启动多代理；实际分派记录 model 与 effort，不声称根会话已切换模型。
- 用户于 2026-09-29 明确将新转录入口改为本地 **WhisperX**，覆盖此前直接调用 faster-whisper 的默认。新转录或补说话人分段前读取 [references/WhisperX转录与说话人分段-v1.md](references/WhisperX转录与说话人分段-v1.md)；双人/多人对谈显式启用 pyannote 分段并合并词级说话人标签。WhisperX 内部仍依赖 faster-whisper，不卸载该底层依赖；不再单独编排其转录调用。已有有效字幕、时间轴与说话人结果按各自缓存复用。

## 开车横版画面与双人竖版复刻（car-dialogue）

用户于 2026-09-27 满意并明确要求后续开车视频复刻已批准竖版。车内固定横双人对话转竖版或用户明确指定该样式时，读取 [references/开车双人竖版复刻-v1.md](references/开车双人竖版复刻-v1.md)，记录 `visual_profile=car-dialogue-v1`，以该参数表覆盖通用黑边、居中画面及视觉字号默认；其他形式不自动触发。

- **开车 + 横版画面（2026-09-29 用户明确补充）**：记录 `car_landscape_layout=true`；无论保留横版输出还是把横版素材放入竖版画布，左上角依然保留“固定机位、安全道路拍摄、专业设备”提示，沿用已确认的大号黄色字体、黑色描边/阴影，不加双引号；按实际可用宽度语义分行。提示文案依据用户确认和本片事实，不把文字当作拍摄条件已验证的证据。
- **标题与背景位置**：标题放在主体画面上方的标题区；主体下方背景及其余填充区沿用同一视觉模板，即从本片素材取背景、模糊并压暗，不改成另一套背景或默认纯黑。保留双人主体，提示、标题、人物贴片和字幕互不遮挡。竖版仍用已有参数表；横版输出保留横向画布并按该比例重排，不能照搬1080×1920坐标，也不能因横版素材而擅自改变最终输出比例。记录输入比例和输出比例，编码前抽帧核对左上提示、上方标题及下方背景三处。

- 此分支只包装最新已确认正文，继承时间线与速度，不强行二次 1.3x；无已确认正文时仍遵守原粗剪确认流程。
- 总控将样式参数交给现有 `douyin-cover`、`douyin-captions`、`xiaolan-broll` 输出领域资产；不得改写其他形式的 canonical 默认。
- 标题与角色文案逐片确认；只有已确认相同素材及角色映射才复用贴片文案，不把参考片标题或人物身份作为全局默认。

## 双人对谈（已确认三条方法）

用户于 2026-09-29 确认三条成片方法，并明确更正触发词为“双人对谈”，不限定开车场景。触发“双人对谈”“两个人聊天”“双人访谈”或“按那三条的方法剪”时，结合实际素材核对两位对谈者及角色映射，记录 `content_profile=dual-dialogue-opinion-v1`；不因触发词直接断言人数或场景。本节负责内容总控编排，地点可以是室内、户外或车内，不替代四个领域 skill。只有符合上节开车双人条件或用户明确要求复刻时才另设 `visual_profile=car-dialogue-v1`；普通双人对谈不自动加安全拍摄提示或套车内构图。

1. **选题与结构先行**：复用有效转录与源时间码；需要从长素材选题时读取 `dbs-content`，需要观点钩子与重排时读取 `dbs-hook`、`dbs-script-flow`。从真实原话中选开头，前三秒进入观点或冲突，不要求整句三秒说完。把候选顺序及源区间写入内容方案，检查“观点 → 必要背景 → 追问/回应 → 落点”；这不是机械套段落。人物、代词指向、数字和课程/事件来由必须可理解；原话缺必要背景时补回源上下文或请用户补录，不伪造原声。
2. **结构确认后精剪**：将内容方案交给 `douyin-rough-cut`，由其内部 `clip-fine-cut-rhythm` 清理重复起句、重启句和可分离气口，再处理速度与同步。保留有信息价值的反方追问和自然衔接；静音候选不直接等于删除指令，不能靠加速掩盖口头冗余。沿用启动卡的形式/B-roll 确认机制；已明确确认的同项目选择直接复用，不重复询问。
3. **冻结后才并行包装**：唯一 EDL/音轨/速度冻结后，字幕、封面与已启用的人物贴片在独立目录并行；总控汇合验收。独立选题可分片并行，各片只设一个时间线写入者。人物贴片不等于开启 B-roll；不因为复刻样式自动加音乐或额外素材。
4. **先低清审核，再高清输出**：沿用现行带规范字幕的 HTML Preview，不新增一个必须单独确认的无字幕粗片阶段；只有用户明确说“无字幕 MVP”才省略字幕。先让用户检查开头、背景、追问与落点是否完整，再按既有流程输出成品。内容重排必须回原片，同步更新字幕映射；自动 ASR/解码通过不冒充人工听审。
5. **后处理与轻量返修分流**：“后处理”表示给已确认正文加封面、字幕、固定片尾并导出正确发布规格，正文未确认则先审核。仅改字幕走上方轻量返修入口，复用时间线和音轨；网页叠加层可快速更新，烧录字幕 MP4 仍需更新受影响画面，不承诺所有改字零渲染。

**内容与视觉分开**：双人对谈新剪正文沿用绝对 `body_speed=1.3`，已确认输入继承 speed manifest、不重复提速；向 `douyin-captions` 传递字幕项目覆盖 `subtitle_line_height=1.2`，不是播放速度。字幕、封面、人物贴片按本片场景与已确认风格执行，不把车内构图变为所有双人对谈的默认。只有 `visual_profile=car-dialogue-v1` 时读取 `开车双人竖版复刻-v1.md`，固定片尾 `outro_speed=1.0`，覆盖后文通用“片尾随整片变速”，安全拍摄说明仍按本片事实确认；非车内形式沿用本项目片尾契约，无契约时按通用默认。用户本轮明确要求优先。

**不固化个案**：参考片中的标题、角色姓名、课程名、金额和某个他/它替换只保留在本项目；不变成全局替换。没有原片时间码和音画映射时，不凭新版总时长推断所有切点或倍速。

可直接复用：
```text
用 AI剪口播，剪这条双人对谈：原话观点前置，补齐背景，保留关键追问；
先清重复和气口，再处理正文绝对1.3倍速，字幕行距1.2倍。
按实际场景选版式，先给低清HTML审核；确认后再做封面、字幕和片尾。
```

## 全流程模型与并行调度（默认入口）

每次剪片、Preview 批注、字幕返修、工程交接或复盘前，读取 [references/任务模型与并行路由-v1.md](references/任务模型与并行路由-v1.md)，按其中任务矩阵和依赖图执行；它是本 skill 的模型/推理强度/并行调度唯一细则。新模型上线或效果变化时以本机可用性和实际验收调整，不照搬旧型号。

- 遵守 `~/.codex/AGENTS.md` 当前分层：复杂、烧脑或模糊任务的分析/拆分/规划/关键决策默认 `gpt-6-astra` high；已明确的非复杂执行默认 `gpt-6.1-sol` low/medium。大批量固定候选才按小样收益选择 `gpt-6-luna` low；确定性探测、文字替换、时间映射、转码与机械 QA 直接用脚本。简单日常轻剪短路进入上方专用入口，不为模型选型再开规划层。
- 同一批只设一个 EDL/共享状态写入者；素材初检可分源并行，上游冻结后字幕/封面/已启用 B-roll 独立并行，汇合验收后再渲染与发布。剪映 GUI 单写入者；小改字直接执行，不为凑模型启动代理。
- 当前运行时最多 4 个 Agent（含总控），因此最多同时 3 个子任务；其他运行时按实际上限缩减。ASR/视频编码的 CPU、内存并发另行限额，不将 Agent 数当作媒体进程数。
- `scripts/codex_callback.js` 的独立增量精剪回调使用显式模型配置；其默认与状态证据以该脚本的配置契约为准，不继承总控型号充当分工，也不声称当前总控会话已切换模型。已有运行任务与人工指定配置保持不变。

## 四个核心 sub-skill

`AI剪口播` 只做总控、唯一 owner manifest、HTML 审核和最终汇合；领域规则以四个独立 canonical skill 为准：

| sub-skill | 负责 | 不负责 |
| --- | --- | --- |
| `douyin-rough-cut` | take 选择、删重复/口误/现场指令、气口、1.3x、切点吞字、字幕文本与原声一致、音画同步 | 封面设计、B-roll 设计、字幕视觉排版 |
| `xiaolan-broll` | B-roll 选材/动效/密度/样片门禁，以及人物贴片文案、位置、时长 | 正文 take 取舍、封面、字幕分页 |
| `douyin-cover` | 干净 A-roll 选帧、标题语义断句、得意黑、多比例裁切铺满、平台无黑边 | 字幕时间轴、B-roll、正文剪辑 |
| `douyin-captions` | 全文纠错、原子词组、字幕断句、得意黑、阴影、安全区、最终 timing | 封面构图、B-roll、正文 take 取舍 |

必须读取 [references/四核心subskill编排-v1.md](references/四核心subskill编排-v1.md)。粗剪是串行前置；它冻结不可变 `upstream_bundle` 的 EDL/media/speed/timing SHA，并由总控冻结共享 `atomic-units.txt` 后，B-roll、封面和字幕才可在独立目录并行，最后由本 skill 汇合验证。

## 剪辑前形式判断与启动卡

用户给出逐字稿和一个或多个视频、并要求剪辑时，先做**只读初检**，由本 skill 自己判断成片形式并给出推荐，不把分类工作丢给用户。只有用户已经在同一条请求里明确指定形式和 B-roll 选择时，才可直接记录决定并继续。

### 只读判断

初检可探测媒体、运行 WhisperX、抽样回听和抽帧，并形成 take/角色候选；不得写 `content_edl.json`、不得正式粗剪、不得渲染整片。主形式只选一个：

- `single_talking_head`：单人口播，同一说话身份持续讲述。
- `dual_role_dialogue`：双人或双角色对话；**一个人分批录完两个角色也归此类**。
- `multi_person_interview`：三人以上、访谈或多人轮流发言。

同时按内容判断 B-roll 推荐：表演、反应和对话节奏本身承载信息时推荐 `none`；只有少量强解释/证据节点时推荐 `light`；教程、流程、对比或技术关系必须靠视觉结构才能明显增进理解时推荐 `structured`。双角色对话默认优先 `none` 或 `light`，保护来回反应；单人解释型内容按抽象密度在 `none` 与 `light` 之间判断。

把候选写入 `preedit_decision.json`，至少包含：`inferred_format`、`confidence`、`evidence`、`recommended_broll_mode`、`role_chips.enabled`、`status=awaiting_user_choice`。然后展示：

```text
剪辑启动判断
- 我判断：双角色对话（推荐）
- 依据：逐字稿有两个角色；两组素材分别对应两个角色
- 形式：A 单人口播 / B 双角色或双人对话（推荐） / C 多人访谈
- B-roll：0 不做（推荐） / 1 轻量 / 2 结构化增强
- 人物贴片：开（双角色默认推荐）/ 关
- 默认交付：删重复口误、气口 0.30–0.40s 且 <=0.5s、1.3x、清晰字幕、封面、低清 HTML Preview
回复“按推荐”，或像“B+1、人物贴片开”这样改选项。
```

`按推荐` 即确认。确认后把 `status` 改为 `confirmed`，并记录 `decision_source=user_explicit|accepted_recommendation`，再允许 `douyin-rough-cut` 写唯一 EDL。用户未确认时仍可完成只读 ASR、角色/素材映射和候选分析，但必须停止在正式剪辑之前。

`broll.enabled` 与 `role_chips.enabled` 是两个独立开关：用户选择不做 B-roll 时，双角色人物贴片仍可开启；用户选择单人口播时，人物贴片默认关闭。轻量或结构化 B-roll 均先交 3–5 个代表性样片，用户确认后才铺整片。

### 选择类封面标题：独立选项分行

调用 douyin-cover 的「导语一行＋每个选项各占一行」规则：例如「求职选 / 母猪产后护理 / 蒙古海军」各为独立语义行，连接词不挂在某个选项上；泛化到职业、专业、品牌/产品等对比标题，不只防止词组内部断字。用户指定的可见行文本优先；同级选项保持相同字号层级，宽度不足统一适配而不拆词。改封面同步更新成片前三帧，正文、音轨、字幕与片尾保持。

### 封面默认嵌入视频前 3 帧（2026-10-01）

- 默认 `cover_frames=3`、`cover_mode=replace_first_frames`：用户选定的当前封面必须写入交付 MP4 的第 1–3 帧（零基帧 0–2），第 4 帧（零基帧 3）恢复正文。封面 PNG 是附带资产，单独图片、网页 poster 或容器缩略图都不等于完成嵌入；仅用户明确要求「只要封面图片」时走图片交付。
- 按实际输出帧率/PTS 处理三帧，不能误写成 3 秒、5 帧或插入三帧后未调整同步。默认替换正文前三帧的画面，不移动正文 PTS、字幕时间、音轨或总时长；已有封面先核对原长度并替换，不重复追加。用户明确指定其他封面时长或插入方式时按本轮要求覆盖并记录时间映射。
- 从最终文件抽看第 1、3、4 帧：1/3 是最新版封面，4 是对应正文且没有残留旧封面。全片解码/音轨等已有有效证据按真实变化复用；改封面不重跑 ASR、不重剪正文、不再次变速。
- 封面文案返修同时更新封面图片与成片前 3 帧，不能只交新 PNG、仍让用户拿旧封面视频发布。可复用兼容封面段/正文缓存；不承诺没有拼接证据的无损替换。
- 每次剪辑或返修完成，明确给出最新视频的绝对目录、成片文件链接及当前预览入口；单独封面路径另列，不能代替视频目录。

### “输出成品”固定含义

- `输出成品` 和 `输出最终产品` 是同义触发词：表示用户已确认当前剪辑，直接从原始素材与已批准时间线生成高清发布版。
- 用户说“最终版本”时，默认交付构成固定为：**当前已选封面 + 当前已验收的完整正文（包含本轮上方已确认的修改与包装）+ 固定片尾**。不得只导出正文；若当前正文已经内置固定片尾，只验证并保留，不得重复追加。
- 默认一次完成 **封面 + 字幕 + 固定片尾**，无需再逐项向用户确认；用户本轮明确排除或改写的项目优先。
- 封面标题若用户未给，可先从成片主旨拟定；用户一旦给出标题，按其原话落版，不擅自换成近义标题。
- 创业系列/“想科技创业第N天”封面必须读取 `references/创业系列封面风格.md`：使用原视频真实行动/出神帧，顶部两行白色加粗斜体阴影字；不要黄色强调、巨大深色面板、截图 UI 黑边/圆角/播放量/时长。
- 没有已批准时间线或整片确认时，停止正式输出并先让用户确认当前剪辑；不得把低清 Preview 放大冒充成品。
- 首版 HTML 前必须由 `douyin-rough-cut` 完成内容取舍、气口、1.3x 和同步检查，并冻结 `sourceKeeps`、`fineKeeps` 与 speed manifest；它内部调用 `clip-fine-cut-rhythm` 做气口和时序硬验收。
- 字幕和片尾仍必须通过本 skill 及字幕 skill 的交付验收，验证失败时不得声称成品完成。
- 进入本路径必须读取 `references/输出成品快速路径-v1.md`，执行“音频先验 → 成品预检 → 1 秒冒烟测试 → 一次高清编码”；禁止整片编码后才首次检查字幕字体或独立 ASR。

### 全局倍速默认

`visual_profile=car-dialogue-v1` 使用上方明确的正文/片尾分轨覆盖；仅“双人对谈”触发不自动启用该视觉覆盖。以下是通用默认。

- 只要任务会交付或 AirDrop 一条口播成片，包括“加字幕 / 抖音字幕 / 返回视频 / 输出成品”，用户未另行指定时，整片画面和声音默认同步 **1.3 倍速**；已有片尾也随整片变速。
- 高清编码前必须读取或写入 speed manifest，至少记录输入倍速、目标倍速、源帧数和输出帧数。输入已经是 1.3 倍速时不得再次套用 1.3；无法确认时回到干净原片重建。
- 变速与烧字幕必须从无烧录字幕的干净原片一次完成：视频用 `setpts` 后锁定交付帧率，音频用相同倍速的 `atempo`，字幕、字词 timing 和 EDL 统一映射到输出时间线。禁止把上一版烧字成片再次变速或重复压缩。
- 用户本轮明确指定其他倍速或要求片尾原速时，按本轮要求覆盖，但不改写长期默认。

## 多视频 Preview v2：依赖顺序与同步门槛

多个视频 + 逐字稿，或用户要求避免口型错位/旧版播放时，必须先读
[references/多视频Preview快路径-v2.md](references/多视频Preview快路径-v2.md)。该规范优先于下文旧的“初检后直接编码”简写。

- 快速素材检查与 3–4 路唯一音频 ASR 并行；小模型/子 agent 只给候选。总控先输出剪辑启动卡，用户确认推荐或改选项后，主会话才冻结唯一源 EDL；未确认时停在只读候选阶段。
- `douyin-rough-cut` 冻结不可变 `upstream_bundle`，且总控用 canonical transcript 生成并冻结共享 `atomic-units.txt` 后，`douyin-captions`、`douyin-cover` 和 `xiaolan-broll` 才可并行；三路只写独立资产/manifest，均不得改共享 EDL。
- 临时 Preview 必须做源相对时序检查：调用 `clip-fine-cut-rhythm/scripts/verify_source_timing.py`。总时长相等、字幕对齐和解码正常不是口型同步证明；失败片不发布。
- HTML 启动后调用 `scripts/verify_served_media.py`，验证实际播放器媒体字节与已验收文件一致且支持 Range。`/api/config` 成功不算发布成功；保护运行任务、批注和旧已验收版本。

## 首版 HTML Preview 前置冻结与门禁

用户审核只处理主观内容取舍；字幕断句、封面断句、气口、字体、人物贴片、B-roll 开关、音画同源和最新版继承必须在首版 HTML 前机械验收。多视频项目先写 `preedit_decision.json`，确认后再写 `project_contract.json`；粗剪 canonical transcript 形成后、视觉 fan-out 前，由总控调用 `douyin-captions` 的原子词提取器冻结唯一共享 `atomic-units.txt`。项目契约至少冻结：`preedit_decision.status`、`decision_source`、`format_profile`、`format_confidence`、`format_evidence`、`source_id→role`、每句原片 PTS、同句多次录制的取舍、目标 `1.3x`、气口上限 `0.5s`、字幕样式、`atomic-units.txt`、`hard-boundaries.json`、封面主副标题语义行、人物贴片文案/位置/时长、`broll.mode`、`broll.enabled`、`role_chips.enabled`、唯一 owner manifest。

### 可并行、不可并行

- 素材探测与各唯一音轨 WhisperX ASR 可并行；逐字稿解析、角色轮次、项目术语/原子词组、封面标题候选和字体/样式预检可并行。
- ASR 齐备后，重复/口误/错误 take/现场指令候选和气口候选可并行分析，但 `douyin-rough-cut` 是唯一 EDL 写入者；字幕、封面和 B-roll 分支此时只做候选或样式预检。
- 主 Agent 串行调用 `douyin-rough-cut` 完成：角色/最后一次完整正确 take → canonical transcript → 唯一 content EDL → 气口 `fineKeeps` → 1.3x timing → owner manifest。只有该链冻结后，三个视觉 sub-skill 才可并行。
- 改字幕、贴片或封面等不改时长的分支必须绑定同一不可变 `upstream_bundle` 的 EDL/media/speed/timing SHA；任何内容/时长变化都会使旧视觉验收失效。

### 🔴 首版 Preview DoD

以下任一项失败都 **STOP**，不得把链接交给用户：

1. `preedit_decision.status=confirmed`，其形式、B-roll 模式和人物贴片开关已由用户明确指定或接受推荐；`douyin-rough-cut` 再验证同句多次录制默认保留最后一次**完整且正确**的 take，删除重复、口误、错误 take 和现场指令；角色、画面和声音来自同一 `source_id` 与同一 PTS。
2. `douyin-rough-cut` 在首版编码前处理全部确认属于空白/换气且输出 `>=0.5s` 的气口；目标 `0.30–0.40s`、最终硬上限 `<=0.5s`，并抽听每个切点，无吞字头、字尾和完整音节。
3. 字幕在分页前完成全文校对，并通过 `douyin-captions` 的 `atomic-units`、跨角色/跨素材硬边界、得意黑字号/阴影/位置/安全区验收；“太爽了”、人名、品牌、术语和数字单位不得拆开。
4. `douyin-cover` 与字幕共享项目原子词组；先冻结语义行再做宽度适配，禁止按字符硬切。得意黑字体必须存在；9:16、3:4、4:3 各自重排并裁切铺满，不得 fit-pad 或留黑边。
5. `xiaolan-broll` 从角色 manifest 读取人物贴片最终文案，放人物右下但不贴底，首次出现显示至少 `4.0s`；B-roll 默认关闭，只有用户明确开启并通过代表性样片后才进入主时间线。
6. `active_release.json` 只指向不可变 bundle，并记录媒体、EDL、字幕、贴片、封面、QA 的 SHA；渲染输入必须等于 active EDL/media SHA，禁止旧 `master_edl` 被重新标成最新版。
7. 完成 1.3x 只应用一次、源相对时序、软件解码、字幕、实际 HTML `/video` 字节 SHA 与 Range 验收后，才切换 `latest` 并显示“加载完整最新版”。

## HTML 选择纯 A-roll 封面

- Preview 播放器提供「设置本帧为封面」按钮；激活视频快捷键后按 **C** 执行同一操作。先暂停，再锁定当前 `video.currentTime`；输入框、输入法组合、长按重复和 Cmd/Ctrl/Alt+C 不触发。
- 封面从 `timelineMap` 对应的干净 A-roll 原片抽取 PNG，禁止截取带字幕/B-roll 的 Preview、播放器 DOM 或 canvas。单片用 `sourceVideo`；多片每段保留 `sourcePath` 与 `originalStart/originalEnd`，这些是物理原片时间，不能用虚拟拼接轴的 `sourceStart` 代替。
- 选择结果写在审核目录 `preview_cover.json`，无文字、无 B-roll 的原始帧写在 `cover_frames/`；页面显示缩略图并可下载，刷新后恢复选择。再次选帧只更新选中记录，保留已有图片，不改批注、试剪时间线或视频。
- 片尾/映射空洞、缺失原片或抽帧失败时保留上一张封面并展示原因，不使用 Preview 截图兜底。已有运行服务加载新接口需在空闲状态重启；仅刷新旧服务的 HTML 不会加载新后端代码。
- 输出成品时优先读取已选 `preview_cover.json`，以 `imageUrl` 指向的 PNG 为封面底图；本次用户只要求图片时不添加标题、字幕或 B-roll。

可复用操作指令：
```text
为当前 Preview 启用 C 选封面：核验每段 A-roll 原片路径与本地时间映射，
部署通用审核页和 preview_cover.js；点击按钮与 C 都从原片抽帧，
保存 preview_cover.json 与纯图片，回读缩略图、选中时间和下载文件。
```

## 输出目录结构

**模式 A（剪口播）：**
```
output/YYYY-MM-DD_HH-MM_视频名/剪口播/
├── 1_转录/   audio.mp3 · whisperx_result.json · subtitles_words.json
├── 2_分析/   analysis.txt · sentence_map.json · speech_errors.json · auto_selected.json
└── 3_审核/   review.html · audio.mp3 · data.json · silence_periods.json
                <视频名>_cut.fcpxml   ← 网页点击「导出 FCPXML」后生成在此目录
                                       拖入剪映 / Final Cut Pro 完成最终剪辑
```

**模式 B（转字幕）：**
```
output/YYYY-MM-DD_HH-MM_视频名/剪口播/
├── 1_转录/   audio.mp3 · whisperx_result.json · subtitles_words.json · raw_text.txt
└── 2_纠错/   corrected.txt · uncertain.md（可选）
视频所在目录/
└── subtitles_formatted.md   ← 最终输出
```

## 流程总览

```
-1. 本地依赖初检（ffmpeg + WhisperX/pyannote + ASR/语言对齐/分段模型缓存；受限模型首次获取检查授权）
0. 确认视频路径 + 选择模式
1-4. 提音频 → 本地 WhisperX（转录 → 词级对齐 → 对谈说话人分段与合并）→ 适配已核实的字幕数据结构（两模式共用）

模式 A（剪口播）:
  5.1 gen_analysis.js
  5.2 读规则.md + analysis.txt
  5.3 AI 判断整句口误 → speech_errors.json（只填 delete_sentences）
  5.4 auto_filler.js → 自动补充词级口癖 idx（快速预筛）
  5.5 AI 逐句扫剩余词级口癖（B2/B3/B4，脚本覆盖不到的部分）
  5.6 merge_selections.js
  6-7. 生成审核网页 + 启动服务器
  【等待用户确认】→ 网页点击「导出 FCPXML」→ 拖入剪映 / Final Cut Pro 完成剪辑
       （导出同时写 3_审核/review_log.json，供步骤 8 学习）
  8. 自进化学习（用户显式触发「已导出，学一下」）→ diff 抽规则 → 确认 → 写 经验规则.md
  8.5 首版审核前由 douyin-rough-cut 调用 clip-fine-cut-rhythm → 原片 sourceKeeps 精修为 fineKeeps → 首版 HTML 前完成气口/吞字/同步门禁；用户确认后再做最终复验
  9. 成片包装 subset（用户要最终视频时）→ 从 fine keeps 一次生成音频/字幕/画面 → 标题/片尾 → clip 交付验收

模式 B（转字幕）:
  B-1 提取纯文本
  B-2 第一步：纠错（只改词，不断行）→ corrected.txt
  B-3 第二步：断行（只格式化，不改字）→ subtitles_formatted.md

模式 C（多段手机口播 Preview→成片）:
  C-1 初检：素材体检 + 多段并行 ASR + 按逐字稿逻辑粗拼 + 三类内容清理
  C-2 douyin-rough-cut 在首版前完成 take/气口/1.3x/吞字/同步并冻结 upstream_bundle；总控冻结 atomic-units 后，字幕/封面/B-roll 并行 → 汇合低清 Preview → 实际媒体入口验收 → HTML
  C-3 HTML 增量审核：每保存两条 Comment 自动局部返修，播放结束时自动处理剩余单条（用户继续往后看）→ 流程一逐块通过 → 全片审完且全部修改通过 → 流程二完整低清检查
  C-4 用户确认后，从同一 upstream_bundle 对气口、切点、字幕文本和音画同步做最终复验；内容变化则重新运行粗剪并使三个视觉分支失效
  C-5 从精剪后的原片 keeps 一次生成高清字幕/封面/片尾发布版，再执行 clip 交付验收

Preview 批注（初版成片之后、正式版之前）:
  P-1 生成 Preview 批注 HTML + Preview→原片时间映射
  P-2 启动本地常驻网址
  P-3 用户按 M 保存批注，每满两条即启动自动修改；无需手动提交或确认已审范围，批注不代表全片通过
  P-4 两条即开工，繁忙时积压待取、每批两条，播放结束时剩余一条自动处理；完成自动接下一批，用户继续看后面，唯一主执行者管理源时间线
  P-5 生成流程一独立审核板块，逐条通过或返修
  P-6 全片明确审完、最新批次均处理完且 100% 修改块 approved 后，才从原片生成流程二完整低清 Preview
  P-7 每保存两条 Comment 自动启动独立精剪执行器；HTML 持续显示正在修改、等待处理、已改好及局部结果入口
  P-8 用户说“复盘一下剪辑”时，冻结并核验历次批注/执行/验收证据，按领域沉淀到对应 canonical skill
```

## 执行步骤

> **路径约定（重要）**：本 skill 不绑定特定 agent，**不要假设它装在 `~/.claude/skills/`**。
> 下面命令里的 `SKILL_DIR` 一律指**本 skill 的安装目录**（即你加载本 `SKILL.md` 的那个目录，
> 含 `scripts/`、`用户习惯/`）。执行前把它设成你实际加载 skill 的绝对路径即可：
> ```bash
> SKILL_DIR="<本 skill 的安装目录>"   # 例：Claude Code 默认 ~/.claude/skills/AI剪口播
> ```
> API Key 的查找顺序见 [scripts/lib/load_api_key.sh](scripts/lib/load_api_key.sh)：
> `$VOLCENGINE_ENV_FILE` → `$SKILL_DIR/.env` → 上一级兼容 `.env` → 环境变量 `VOLCENGINE_API_KEY`。
> 已验证的 skill-local 配置优先，避免旧进程环境变量误覆盖。

### 步骤 -1: 本地转录依赖初检

默认使用本地 WhisperX；按上方新入口规范检查 ffmpeg、Python、WhisperX/pyannote 版本、ASR 模型、中文等对应语言对齐模型和说话人分段模型。复用已安装环境；首次获取受限模型需要核验 Hugging Face 授权及模型条款，密钥不写日志。已缓存且可离线加载时不重复获取。仅缺 ASR 时才新转录；只缺对齐或说话人结果时只补相应阶段。

`doctor.js`、`.setup_done` 和 `run_transcribe.sh` 属于旧云端入口：它们的云端检查通过不代表本地环境通过，也不得因为没有云端 key 阻塞本地剪辑。现存 `run_transcribe.sh` 仍是云端脚本，**本地流程不得直接调用它**。缺依赖或缓存时报告具体缺项并修复本地环境，不自动改用极速版。

### 步骤 0: 只读判断 + 剪辑启动卡

收到视频和逐字稿后先探测素材、抽样 ASR、识别角色与 take 分组，并展示推荐；不得因用户说“直接剪成片 / 返回视频”就跳过形式与 B-roll 决定。用户已在同一请求中明确指定形式和 B-roll 时，记录为 `user_explicit` 并直接继续。

```
剪辑启动判断
- 我判断：<单人口播 / 双角色对话 / 多人访谈>（推荐）
- 依据：<逐字稿角色 + 素材/声音/服装证据>
- 形式：A 单人口播 / B 双角色或双人对话 / C 多人访谈
- B-roll：0 不做 / 1 轻量 / 2 结构化增强
- 人物贴片：开 / 关
- 默认交付：删重复口误、剪气口、1.3x、字幕、封面、低清 HTML Preview
回复“按推荐”或直接改选项。
```

用户确认后再继续；此前不写 EDL、不正式粗剪、不生成 B-roll。

### 步骤 1-4: WhisperX 转录、对齐与说话人数据准备（无需另派 GPT）

1. 每个唯一音轨提取一次音频；按源音频指纹和 ASR 参数复用有效缓存。
2. 使用当前主机已验证的 WhisperX 环境和缓存模型；顺序执行 ASR、对应语言词级强制对齐。双人/多人对谈还须显式运行 `whisperx.diarize.DiarizationPipeline` 与 `assign_word_speakers`，按新入口规范保留 unknown/overlap。Whisper 模型规格与 GPT 的 medium/high 推理强度分别记录；导入 WhisperX 或仅跑 ASR 不等于已完成说话人分段。
3. 保留原始 ASR、aligned segments/words、diarization、词级 speaker/unknown、源 PTS 和模型参数；接入 `gen_analysis.js` 等现有工具前先核对其实际输入 schema，再做显式适配。不要把 Whisper JSON 改个文件名就当作火山 JSON。
4. 探测、提音频、ASR 和 schema 适配由工具执行，不额外派 LLM。分源并行按任务矩阵限额；只对疑词区间复听、校对，不因四个子任务各自需要字幕而重复整片识别。
5. 已有用户验收的字幕和冻结音轨时直接复用；仅改字走 `patch_caption_text.py`，跳过本节。

### 步骤 5: 生成分析文件 + 口误识别

#### 5.1 生成分析文件

```bash
node "$SKILL_DIR/scripts/gen_analysis.js" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/2_分析"
# 输出: analysis.txt + sentence_map.json + auto_selected.json
```

#### 5.2 读取规则 + 分析文件

读 `用户习惯/规则.md`、`用户习惯/经验规则.md`（自进化沉淀的个人偏好，见步骤 8）和 `analysis.txt`。
两份规则都要遵守；冲突时以更具体、更新的为准。

`analysis.txt` 格式（每行一句，序号: 文本）：
```
0: 直接开始了啊
1: 这是深圳腾讯总部楼下
2: 就为了安装一只
```

#### 5.3 AI 判断整句口误（只填 delete_sentences）

> ⚠️ 由你直接阅读 `analysis.txt` 并判断哪些**整句**是口误。
> **本步只填 `delete_sentences`**，`delete_idx` 留空数组。词级口癖留到 5.4（脚本）+ 5.5（AI 补漏）。

按 `规则.md` 的 **A 节（整句删除）** 判断：重复重说、残句、句内卡顿、只含语气词的整句等。

**输出格式**（写入 `$BASE_DIR/2_分析/speech_errors.json`）：
```json
{
  "delete_sentences": [2, 3, 8, 10],
  "delete_idx": []
}
```

#### 5.4 脚本自动识别词级口癖（无需 AI）

```bash
node "$SKILL_DIR/scripts/auto_filler.js" \
  "$BASE_DIR/2_分析/sentence_map.json" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/2_分析/speech_errors.json"
```

脚本会**就地修改** `speech_errors.json`，把识别到的口癖 idx 合并进 `delete_idx`：

- 任意位置：`呃 / 嗯 / 额 / 诶 / 欸 / 唉 / 噢`（已排除"额外/金额"等真词）
- 任意位置的：`然后`（用户偏好：宁可手动加回）
- 句首过渡词：`然后 / 那么 / 好的 / 啊 / 哦 / 哎 / 呀 / 对 / 呢 / 那`（"那"会避开"那个/那么/那里"等）
- 句尾废词：`对 / 呢 / 啊 / 哦`
- 跳过已整句删除的句子；保护剩余字数 ≤3-4 的短句不被掏空

跑完后，用户已手工填的 idx 也会被保留（合并去重）。

#### 5.5 AI 逐句扫剩余词级口癖（脚本覆盖不到的部分）

脚本只处理"无需上下文判断"的安全口癖。AI 在此扫 `analysis.txt`，找出脚本覆盖不到的：

- **B4 句中重说**（优先级最高）：前半段说错、后半段纠正 → 删前半段，保留后半段
- **B3 冗余引导短语**：大家可以看到、你看、给大家看一下、比如说你看一下、我可以告诉你、你明白吗
- **B2 句中填充词**（**慎用**，需明确判断为口癖才删）：其实、就、也、大概、这个、那个、就是
- **B5 脚本未覆盖的句尾拖音**

**工作方式（避免 token 爆炸 + 过删）：**
1. 顺序扫 `analysis.txt`，只标"明显有问题"的句子。没明显问题的句子直接跳过，不要为了"也许能再删一点"硬挑刺。
2. 把候选句号攒成一批（建议 20-30 句一组），**一次** `gen_word_detail.js` 调用拿到词级 idx。
3. 把新增 idx **合并**写回 `speech_errors.json` 的 `delete_idx`（与 5.4 结果取并集，不要覆盖）。

```bash
# 一次传多个句号，减少往返
node "$SKILL_DIR/scripts/gen_word_detail.js" \
  "$BASE_DIR/2_分析/sentence_map.json" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  5 8 12 24 25 44 ...
```

**判断尺度**：句子已经能读通就不要再动。剪口播的容错来自审核网页（用户能取消勾选），但**误删比漏删难恢复**——用户得手动取消勾选才能找回。所以**漏删优于过删**。

#### 5.6 合并到 auto_selected（代码自动映射句号→idx）

```bash
node "$SKILL_DIR/scripts/merge_selections.js" \
  "$BASE_DIR/2_分析/sentence_map.json" \
  "$BASE_DIR/2_分析/speech_errors.json" \
  "$BASE_DIR/2_分析/auto_selected.json"
```

### 步骤 6-7: 生成审核数据并启动服务器

```bash
# 6. 生成 data.json + review.html（从 templates/review.html 复制）
#    前端模板在 scripts/templates/review.html，改样式直接改那里
node "$SKILL_DIR/scripts/generate_review.js" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/2_分析/auto_selected.json" \
  "$BASE_DIR/1_转录/audio.mp3" \
  "$BASE_DIR/3_审核"

# 7. 启动审核服务器
#    serve_review.sh 会自动选端口、在【一个独立的 OS 终端窗口】里前台运行服务器、
#    健康检查、打开浏览器；若环境禁止开新窗口，会打印一条手动命令兜底。
#    （不要再用 `&` / nohup 在 agent 后台挂服务——见下方「为什么」。）
bash "$SKILL_DIR/scripts/serve_review.sh" \
  "$BASE_DIR/3_审核" "$VIDEO_PATH" "$SKILL_DIR/scripts/review_server.js"
```

> **⚠️ 为什么必须用 `serve_review.sh`，不能直接后台 `&`/nohup 挂服务（重要，否则用户会「拒绝连接」）：**
> 审核网页要这个本地服务**一直监听端口**。但各 agent 对后台进程的处理不同：
> - **Claude Code** 有常驻进程管理器，会在整个会话期间替你保活后台进程 → 直接 `&` 也没事；
> - **某些 agent（如 Codex）** 把每条命令放在临时子进程/沙箱里，命令一返回就**回收整棵进程树**
>   （连 `nohup`/`disown` 的子进程也杀）→ 端口失联，浏览器报「localhost 拒绝了连接请求」。
>
> 所以**不要依赖 agent 替你保活**。`serve_review.sh` 改在 OS 层另起一个真正的终端窗口前台运行
> （macOS 写可双击的 `.command` 并 `open`；Linux/Windows 起对应终端），它由系统拥有、不随 agent
> 命令回收。脚本最后还会打印一条 `bash "<3_审核>/启动审核服务.command"` 的手动命令——
> 万一连开窗口都被禁，让用户在自己的终端里跑这一条、**保持窗口开着**即可。
>
> 服务器启动时会把地址写进 `3_审核/server_url.txt`、进程号写进 `.review_server.pid`，方便排障。

用户在网页中：播放片段确认 → 勾选/取消 → 点击「导出 FCPXML」→ 生成的 `*_cut.fcpxml` 拖入剪映或 Final Cut Pro 完成最终剪辑。

> **导出时服务器同时写一份 `3_审核/review_log.json`**（与 FCPXML 同一次点击产出）：记录
> AI 初选 idx、用户最终 idx、切割参数，以及二者**词级 diff**（带文字+句子上下文）。
> 这是步骤 8「自进化学习」的唯一原料，**不读 `.fcpxml`**（那是算完的时间线，丢失了词级选择）。

### 步骤 8: 自进化学习（用户显式触发）

> **不自动跑。** 用户导出后，在**任意会话**说「<项目> 已导出，学一下」之类，才执行本步。
> 本步只读文件、不依赖对话上下文还在，所以冷会话也能跑。

1. **定位日志**：单个项目读 `<project>/剪口播/3_审核/review_log.json`；
   批量重学则 glob `~/Desktop/output/*/剪口播/3_审核/review_log.json`，逐个汇总。
   （日志只存在项目里，清理 output 会丢语料。）
2. **读现有规则**：先读 `用户习惯/经验规则.md` **全文** + `用户习惯/规则.md`，避免重复提已有规则。
3. **看 diff 抽规则**：对每条 `diff.aiOnly`（AI 想删你留回，可能过删）和 `diff.userOnly`
   （你删了 AI 没想到，可能漏删），对比「AI 为何这么剪 vs 你为何这么剪」，
   抽象出**能泛化到下一条视频**的通用偏好。**严禁**把单条口误/语境例外固化成规则。
4. **违例提醒**：若 diff 显示用户违反了某条已有规则，**逐条提醒**用户，让其判断
   是「正当例外（规则不动）」还是「该改松/加例外条件」。
5. **列给用户确认**：把候选的【新增 / 细化已有 / 合并重复 / 改某条】列出来，**等用户确认**。
6. **写入**：确认后才改 `用户习惯/经验规则.md`，每条带出处标签 `（学于 <视频名> YYYY-MM-DD；已确认）`。
   下次步骤 5.2 即生效。

### 步骤 8.1: Preview 批注复盘与偏好沉淀

用户说“复盘一下剪辑”“复盘剪辑”“学一下我的剪辑偏好”或“把这次批注沉淀到 skill”时，读取
[references/Preview复盘沉淀规范-v1.md](references/Preview复盘沉淀规范-v1.md) 并完整执行。

用户只提供剪映等外部手剪 MP4 并要求“对比/学一下/沉淀”时，也走该复盘流程；执行规范中的“外部手剪成片”分支，不把它当作已有网页批注提交。

该流程与上面的模式 A 词级 diff 学习并列：它读取模式 C/P 阶段的不可变提交快照、执行日志、结构化结果、EDL/产物和用户验收。先验证任务主机与项目路径，再运行 `scripts/build_preview_retrospective.js` 生成带哈希的证据清单；不依赖当前聊天仍保留，也不要求用户重新复制批注。

按总控/HTML、粗剪、B-roll与人物贴片、封面、字幕分别路由到 `AI剪口播`、`douyin-rough-cut`、`xiaolan-broll`、`douyin-cover`、`douyin-captions`；`clip-fine-cut-rhythm` 是粗剪 sub-skill 的内部气口与时序引擎。单点修改、失败执行、未验收推断和已有规则的同义重复不得写入 skill。

### 四核心 sub-skill → Preview → 成片固定路由

1. `douyin-rough-cut` 从原片完成 take 选择、删重复/口误/错误 take、气口、1.3x、吞字和音画同步检查，冻结 `sourceKeeps`、`fineKeeps`、speed manifest 与最终 timing。
2. 上游 SHA 冻结后并行调用：`douyin-captions` 生成字幕资产，`douyin-cover` 生成多比例封面候选，`xiaolan-broll` 生成已启用的代表样片/人物贴片资产。三者不得修改 EDL。
3. `AI剪口播` 汇合三路 manifest，完成带字幕低清 HTML Preview；只有 B-roll 样片通过后才允许把其事件合入完整时间线。
4. 用户确认后，从原片和同一 `fineKeeps` 一次生成高清正文，加入已确认封面、字幕、B-roll/贴片和片尾，不二次变速、不复用烧字旧片。
5. 最终成片回到 `douyin-rough-cut` 的交付契约，并由其内部 `clip-fine-cut-rhythm` 与 `douyin-captions` 验证 metadata、软件/VideoToolbox 解码、源相对时序、字幕和全部切点。

缺少任一核心 sub-skill 的 required manifest、上游 SHA 不一致或任一硬验收失败 → **STOP**，不得发布 Preview/成片。

### 模式 C: 多段手机口播 Preview→成片

当用户提供多段手机录制视频和参考逐字稿，并要求剪成一条口播时，读取
[references/PeterHub多段口播成片规范.md](references/PeterHub多段口播成片规范.md) 并完整执行。

快路径规则：

1. “初检”是一个完整动作：多段并行 ASR、把真实表达按逐字稿逻辑粗拼、清理三类内容。逐字稿不要求逐字一致；真实 ASR、原声和画面仍是事实依据。
2. 初检只做三类清理：明显废话与过度重复；“这段删掉 / 那段剪掉”等拍摄现场指令；与 IP 导演、IP 助理关于拍摄是否完成的对话。像“开始吧 / OK 开始 / 可以了 / 就这样”这类 100% 明确只服务于录制流程、而非正文语义的开拍或收尾话，必须在初检清掉。保留有价值的临场扩写和自然气口，不在初检做碎切精修。
3. 初检和唯一 EDL 冻结后，按 v2 先完成字幕/音频与长段音画小样两条先验通路，再编码带规范字幕低清 Preview；源时序、字幕和解码检查通过后生成映射并启动 HTML，最后核对实际播放媒体字节。用户明确要求“无字幕”时才跳过字幕；不得因为是 Preview 就擅自省略。**这不是一个需要用户单独收货或确认的 Rough Preview 阶段**；HTML 是初检后的第一个用户审核界面。画面保持与正式版相同纵横比，默认 270×480、30fps、H.264 CRF 30、AAC 96kbps；倍速继承本轮目标。字幕必须调用 `douyin-captions`，按正式画布等比缩放字号、位置、阴影和安全边距。
4. HTML 内部采用增量审核：用户每保存两条 Comment 即在后台开始局部低清返修，结尾剩余一条自动处理，不等手动确认，用户继续看后面；修改块做好即进入流程一。只有全片明确审完、最新批次均处理完且修改块全部通过，才统一生成流程二完整低清 Preview。未确认前始终不渲染高清。具体执行和旧页面接入边界见下方增量规则。
5. 第一次 HTML 编码前必须已由 `douyin-rough-cut` 从原片完成气口、1.3x、吞字和音画同步处理；不得把这些机械问题留给用户指出，也不得在低清 Preview 上二次剪。
6. 用户说“输出成品 / 输出最终产品”时，先冻结精剪 `fineKeeps` 和封面标题；未给标题时只生成低成本封面静帧供确认，不启动高清主体编码。标题确认后，按 `references/输出成品快速路径-v1.md` 生成最终音频母版并完成独立 ASR/字幕 timing，再运行成品预检和 1 秒中文字体冒烟样片；两项都通过后只做一次高清编码，最后执行 `clip-fine-cut-rhythm` 交付验收。
7. 参考稿中没有实际录到的段落不得补造；录音中与主题一致的扩写不得只因参考稿没有就机械删除。

若用户只要剪辑方案、审核稿或透明母版，不自动执行最终发布包装。

### Preview 批注阶段

当用户要“先看初版再改”“给视频打 mark / comment”“听到问题按 M 标记”或反馈逐句修改成本太高时，生成 Preview 批注网址。这个阶段审核的是**已经剪出的 Preview 成片**，不同于模式 A 的逐词删选审核页。

首次生成或处理 Preview 批注前，先读取 [references/Preview批注双窗口处理规范-v1.md](references/Preview批注双窗口处理规范-v1.md)。该规范保留双窗口基线，并包含 2026-08-29 修正的保存即自动处理规则；本节只保留必须执行的摘要。

#### 默认增量节奏：你往后看，我改前面

用户已确认这一长期流程；不再等所有反馈收齐才开始局部修改。执行前读取双窗口规范中的“增量审核”一节。

1. **两条保存即开工**：用户按 M 写 Comment 并保存，每满两条立即自动处理，不再等待 5 秒，也不要求点击“立即处理当前批次”或“已审到这里”。第一条仅保存等待第二条，未保存草稿不提交。
2. **结尾单条也处理**：播放器到达结尾（含试剪时间线的最后一段）后，自动处理已保存的剩余一条。结尾新保存的 Comment 同样自动处理；回退播放位置则恢复两条触发。结束信号只清空已保存建议，不代表全片通过。执行器忙时保存尾条请求，结束后自动接续，不依赖页面轮询。
3. **后台调度、一个主时间线**：当前运行时同一时刻一个主协调执行器，每批两条；重复保存同一版本不重复启动，失败或过期批次不阻塞后面的有效建议。局部任务只写独立输出目录，重叠批注合并理解，删句/顺序/倍速由唯一主执行者协调，避免多个结果争写共享 EDL。
4. **继续看，不换底片**：批注绑定原片 ID/PTS 区间、段落实例和 Preview/EDL 版本；保留用户正在看的版本。新结果放到独立的逐块审核页，只复查修改处及接缝。旧批注被改写、撤回或依赖变化时，对应任务和旧审批失效，重做受影响部分；不要覆盖活动批注。
5. **局部先审，后台合入完整预览**：点击「通过并应用」才记录对应修改版本的验收，后台把已通过的修改合入完整低清 Preview，其他位置保留基准；未通过不等于全片不能预览。合成中新增的验收合并进下一轮，一个合成任务串行发布。新版验证通过后显示「播放完整新版」，用户明确点击才换主播放器，保留位置、试剪和批注；不整页刷新，不在浏览器播放时临时拼小片段。最终高清导出仍需全片审完和相关修改通过。B-roll/字幕等不改时长时复用原音轨；结构修改按同一源 EDL 同步重建音画。详见 [references/Preview验收合入-v1.md](references/Preview验收合入-v1.md)。

**接入边界（2026-08-28 已接入）**：当前 `preview_review_server.js` + `codex_callback.js` 已实现自动增量批处理。上线或接手旧页面时仍必须先验 `/api/config`、`/api/codex-status` 和页面控件，确认 `incremental_review_state.json` 可读写、`codex_batches/<batchId>/` 能冻结快照、同一时刻只有一个主协调 worker、活动视频/comments 不被替换；若某个旧页面尚未重启到新版 server/template，则先部署自动保存入口，不得宣称自动开工。

**运行时细则**：

- 保存 comment 后按 marker `id + contentHash` 追踪 fresh 版本；未解决且有评论文本的批注保存即进入待处理集合，满两条启动。
- 服务端收到持久化 Comment 后按两条调度，默认 `debounceMs=0`；繁忙时先积压，空闲后按两条冻结快照，结尾 `flushPending` 保证尾条不丢。启动服务会恢复待处理工作，完成自动接续不依赖浏览器轮询。
- 冻结批次时立即写 `codex_batches/<batchId>/comments.json`、`timeline.json`、`preview_review_config.json`、`batch.json`，并记录 `basePreviewSha256`（来自 `preview_review_config.previewVideo`）、`baseEdlHash` 和 `markerRevisions`。
- 页面移除手动批次与已审按钮，只展示正在修改/等待处理/已改好及可选“暂停自动修改/继续自动修改”；先保存试剪时间线，再保存 Comment，成功后刷新状态。暂停不删除队列，继续时自动开工；旧提交 API 仅保留兼容。
- marker 删除、resolved 或内容 hash 变化会使旧 queued/running/completed/failed 批次变 `stale`；失败批次保持 held，避免轮询无限重试。
- worker 固定 `codex exec --ephemeral`，prompt 只允许写本批目录下的局部 review clips、proposal、结果页和 QA；禁止改活动 HTML/config/comments/video、共享 EDL 或流程二完整视频。
- 完成必须有有效结构化 result JSON、每个 marker 的 item 和真实存在的输出路径；worker exit 0 但无结果仍为 failed。


用户要求“复盘一下剪辑”时不要停留在活动批注文件；改读 [references/Preview复盘沉淀规范-v1.md](references/Preview复盘沉淀规范-v1.md)，核对历次不可变提交、真实执行和验收后再更新 skill。

```bash
SKILL_DIR="<本 skill 的安装目录>"
PREVIEW_VIDEO="/path/to/preview.mp4"
REVIEW_DIR="/path/to/project/4_Preview批注"
EDIT_SUMMARY="/path/to/preview_edit_summary.json"  # 可选，但推荐

node "$SKILL_DIR/scripts/prepare_preview_review.js" \
  "$PREVIEW_VIDEO" "$REVIEW_DIR" "$EDIT_SUMMARY"

bash "$SKILL_DIR/scripts/serve_preview_review.sh" \
  "$REVIEW_DIR" "$PREVIEW_VIDEO" \
  "$SKILL_DIR/scripts/preview_review_server.js"
```

执行要求：

1. 有剪辑摘要时必须传入。摘要至少包含 `speed`、`source` 和 `keeps[{start,end}]`；页面会同时保存 Preview 时间和对应原片时间，后续不要靠人工换算。
2. 点击视频框后激活快捷键：`Space` 只负责播放/暂停切换，`M` 必须先暂停，再以当前精确时间打点并把焦点放进评论框，`G` 在“非全局 / 全局检查”之间切换，`J/L` 前后 2 秒，`[/]` 前后 0.1 秒。页面底部必须提供剪映式非破坏试剪轴：`E` 在播放头分割，`A` 删除当前片段左边缘到播放头，`S` 删除播放头到当前片段右边缘，`D` 删除选中的整个片段，`Command/Ctrl+Z` 撤销；保留片段磁吸排列，播放自动跨过删除区间。新批注分类默认选中中性的“其他”，范围默认“非全局”；“这里短一点”等带明确动作倾向的分类只有在用户主动选择后才生效。全局批注仍保存 M 点和双窗口作为锚点，但处理前必须读取完整逐字稿和全片结构，可删、改或调整到其他位置。评论框内 `Enter` 保存批注、`Shift+Enter` 换行；保存或取消后焦点必须回到视频框，让下一次 `Space/M` 立即生效。`Enter` 不参与视频播放。须兼容 macOS 全局语音输入向评论框写入文字，输入或输入法组词期间不得抢占按键。
3. `M` 是批注的精确锚点。每条批注固定保存两个窗口（靠近片头片尾时截断）：**回顾窗口** `[M-6 秒, M+4 秒]`，**处理窗口** `[M-3 秒, M+3 秒]`。先听完回顾窗口并读对应逐字稿，再结合评论判断处理窗口内要删什么、改什么或如何修气口；两个窗口都不是机械删除范围。
4. 批注自动写入 `$REVIEW_DIR/preview_comments.json`；试剪轴自动写入 `$REVIEW_DIR/preview_timeline.json`。每条批注包含分类、评论、精确 `previewTime/sourceTime`、`reviewPreviewStart/reviewPreviewEnd/reviewSourceRanges`、`actionPreviewStart/actionPreviewEnd/actionSourceRanges` 和解决状态；时间线保存用户最终保留的 Preview 片段。两者都不得只留在浏览器内存。任一范围跨越 Preview 拼接点时，其原片范围必须保留为多段，不能错误合并。
5. 处理批注时必须把回顾窗口对应的原片音频和逐字稿交给执行者；处理窗口只是默认 edit 边界，真正切点必须对齐词级时间戳、天然停顿和完整语义。相邻或重叠的 M 点先合并成一个上下文审核任务，禁止在 Preview 上逐点叠加碎切。
   先生成批注处理包：
   ```bash
   node "$SKILL_DIR/scripts/build_preview_edit_packets.js" \
     "$REVIEW_DIR/preview_comments.json" \
     "$REVIEW_DIR/preview_review_config.json" \
     "/path/to/subtitles_words.json" \
     "$REVIEW_DIR/preview_edit_packets.json"
   ```
   脚本会同时读取同目录的 `preview_timeline.json`，输出 `manualTimeline.sourceKeeps`。执行者逐条读取 `reviewWindow.transcriptSegments` 后，才允许提出 `actionWindow` 内的精确 edit；用户用 `E/A/S/D` 明确完成的试剪优先于自动建议，并须按 `sourceKeeps` 回原片重建。
6. 用户提交批注后，先按 `actionSourceRanges` 回到原始时间线修改；若缺少范围映射，再用 `sourceTime` 定位；两者都没有时才按 `previewTime` 定位 Preview。
7. 网址必须用 `serve_preview_review.sh` 启动到独立 OS 终端，避免 agent 命令结束后服务器被回收。启动器将检查实际 `/video` 哈希与 Range；手动服务也必须对播放器 `currentSrc` 执行 `verify_served_media.py`。确认已验收版本后才交付网址和 `启动Preview批注.command` 路径；指定端口被占用不得误认旧服务为新服务。
8. 正式版完成前逐条处理批注，并把已处理项标为解决；不要把用户评论直接当成可机械执行的精确切点，仍需检查相邻字头、字尾和完整语义。
9. 用户保存批注时，页面必须先确认 `preview_comments.json` 与 `preview_timeline.json` 保存成功，再按两条自动通过本机回调服务异步启动 `codex exec --ephemeral` 独立精剪执行器；禁止对桌面版正在占用的任务执行 `codex exec resume`，也禁止使用 `--last` 或要求用户复制清单再粘贴。回调只监听 `127.0.0.1`，使用随机令牌并拒绝重复运行；它是唯一主调度入口，不是同时启动多个全量回调。局部子任务只写独立目录。执行器进入四个阶段时主动输出 `进度 X/4：...`；页面从真实 JSONL 日志显示已运行时长、阶段、当前动作、最近更新时间和最近 5 条记录，不伪造百分比。长命令期间即使没有新消息，也必须显示进程仍然存活和最后已知动作。完成或失败后直接展示最终回复或真实错误。只要 Codex CLI 可用即可启用自动处理，不依赖 `CODEX_THREAD_ID`。
10. 批注重剪采用两阶段闸门：先生成 `annotation_block_review.html`，让用户逐个审核每条修改后的约 10 秒独立板块（修改点前后各 5 秒；边界处向另一侧补足）。`→` 通过并进入下一个，`←` 返回，`M` 定点 Comment，`Enter` 保存“需要再改”。只有用户明确全片审完、最新批注处理完且无在途任务，并且 `review_blocks.json` 中全部修改板块均为 `approved`，才允许生成流程二的完整视频；不得先把这些板块拼成一条 Review 视频，也不得在流程一未通过时抢跑完整版本。
11. 返修某个板块后只重渲染该板块；`build_annotation_block_review.js` 现有指纹比较 `sourceRanges` 和 `editSummary`。主执行者另按增量规范核对源素材、速度、渲染和字幕/B-roll 依赖；任一实际内容依赖变化都使旧 `approved` 失效为 `pending`，并保留 `reviewerComment`。全局样式另建审核对象，不能因旧脚本只比较两个字段而沿用通过状态。
12. 判断流程一板块“有没有新返修 Comment”必须读取 `reviewerComment` 和 `reviewerCommentTime`；初始 M 批注则读取 `preview_comments.json` 的 marker/内容指纹，两者不混用。不要只统计不存在的 `comments[]` / `reviewComments[]`。用户在聊天中明确说某个返修“好了 / 通过”时，可将对应的唯一 `pending` 板块记为 `approved`，并写入 `reviewedAt`；如果仍有多个未通过板块，不能把这句话泛化成全部通过。
13. 流程二固定从原片和 `review_edit_plan.json.keeps` 重建，不在低清 Preview 上二次剪。完整低清 Preview 用：
   ```bash
   node "$SKILL_DIR/scripts/render_approved_full_preview.js" \
     "/path/to/source.mp4" \
     "$REVIEW_DIR/review_edit_plan.json" \
     "$REVIEW_DIR/review_blocks.json" \
     "/path/to/full-preview.mp4"
   ```
   调用脚本前主执行者先核对全片审核覆盖、最新批注版本和队列已清空；脚本本身会硬性检查全部板块为 `approved`，否则退出，不应把脚本的局部通过检查当成全片已审证明；临时 MP4 还必须通过 `verify_source_timing.py` 才发布，失败保留旧成片。低清审核版默认保留或重建规范字幕；只有用户明确要求无字幕时才跳过。分辨率可用 270×480，倍速继承 edit plan，字幕样式按画布宽度等比缩放。输出后完整解码，并用 `ffprobe` 核对视频/音频时长差、30fps、分辨率、码率和文件体积；音画时长差应控制在 100ms 内。

### 双角色与人物贴片路由

- 双人／多角色口播必须在唯一 EDL 中冻结 `role + source_id`，并保存角色贴片 manifest。需要口型成立的对白，画面与音频必须来自同一原片、同一 PTS；跨源配音只允许明确标注的 B-roll、离镜反应或画外音。
- 每个角色首次正式出场时显示一次项目确认的称号、姓名、颜色、位置和时长；局部返修、完整新版和正式成片都必须从同一 manifest 重放，不能在重建时间线时丢失或换错角色。
- 人物贴片的文案、位置、时长和 B-roll 避让以 `xiaolan-broll` 为唯一领域规则；本 skill 只冻结 `role + source_id` 并汇合它输出的角色贴片 manifest。
- 渲染后必须回读时间线并验证每张贴片 `end-start >= 4.0`，再抽查入场、中段和退场帧；只检查代码或 manifest 不算通过。
- 贴片、封面、字幕样式等视觉包装返修必须以“最新已合入内容 EDL + 该版媒体哈希”为上游；禁止为了改视觉参数重新调用旧 `master_edl`，也禁止把“旧内容 + 新包装”标成最新版。重渲染前先比较最新批注合入 manifest 的覆盖数和 EDL 哈希，渲染后再回读开头、用户点名处和末尾，确认内容版本没有倒退。

### 步骤 9: 成片包装 subset

当用户要求“返回视频 / 抖音版 / 视频号版 / 横版转竖版 / 加标题 / 加片尾”时，先完成上方四核心路由；本 skill 只负责汇合，各视觉领域分别调用已列出的 sub-skill。

正式“输出成品”优先使用 `references/输出成品快速路径-v1.md`；下面是视觉和编码规范，不覆盖快速路径的前置顺序。

开始前读取 [references/横版转竖屏成片规范.md](references/横版转竖屏成片规范.md)，按其中的基准参数和缩放规则执行。只要输入或输出是用于抖音、视频号等平台的 `1080x1920` 口播视频，还必须调用 `douyin-captions`：常规字幕固定使用剪映 15 号得意黑、白字、黑色柔和阴影并关闭描边。默认规则（`visual_profile=car-dialogue-v1` 的固定片尾原速覆盖优先）：

1. 正片视频和音频同步使用 **1.3 倍速**；这是长期默认值，覆盖历史任务中使用过的 1.15 和 1.2 倍速。
2. 横版正片输出为 1080x1920，保持宽高比并水平、垂直居中，上下区域填纯黑。
3. 上方标题默认使用得意黑（Smiley Sans）两行排版；白色主字，关键词可用蓝色强调。
4. 补充截图或评论区图片必须放在正片画面区域中央，不得放进上下黑边。
5. 片尾追加在最后，默认随整片使用 1.3 倍速并保持原生竖屏全画面；不要叠加正片的黑边、标题或插图。只有用户明确要求时才保留原速片尾。
6. 需要封面时调用 `douyin-cover`；本 skill 只读取其已确认 `cover_manifest.json`，不得在总控中另写一套封面断句、字体或多比例裁切逻辑。
7. 普通发布版最终统一用 `scripts/compress_publish.sh` 做一次 FFmpeg 快速压缩；不要重复压缩中间文件。
8. 导出后检查第 1、5、6 帧，中段、插图出现处、正片转片尾处和片尾帧，并用 `ffprobe` 核对分辨率、时长、码率和视频/音频流。

### 🔴 CHECKPOINT：高清编码前置闸门

同时满足以下条件才允许启动整片高清编码：

1. `douyin-rough-cut` 已冻结 `sourceKeeps`、`fineKeeps` 与 speed manifest；正式编码使用同一上游 SHA。
2. `douyin-cover` 的封面标题及本轮需要的比例资产已验收，无黑边；默认 cover_frames=3。编码前用代表性短样检查第1/3/4帧，不要求尚未生成的正式成片先通过；正式编码后再检查最终文件第1/3/4帧。
3. 最终音频母版已生成，独立 ASR 对齐已完成；字幕数据无 0 时长、倒序或跨素材页。
4. `scripts/final_product_preflight.py` 退出码为 `0`，且 1 秒 1080×1920 中文字体冒烟样片人工可读。
5. 已写缓存 manifest；源 EDL、标题、SRT 或渲染参数未变化的分段不得重复生成。

任一项失败 → **STOP**。只修对应分段，禁止重跑完整剪辑、固定片尾和其他已通过缓存。

快速路径资源：

- `references/输出成品快速路径-v1.md`：正式成品的顺序、缓存键、失败分支和真实进度协议。
- `scripts/final_product_preflight.py`：长编码前校验 EDL、源文件范围、逐词 timing、中文字体和固定片尾。
- `scripts/test_final_product_preflight.py`：预检脚本的 0 时长与非单调 timing 回归测试。

正式文件编码完成后仍未结束：必须调用 `clip-fine-cut-rhythm` 的全部 Delivery Gates；通过后才允许交付。

显式用户要求优先于默认值。例如用户明确指定 1.2 倍速或要求片尾也加速时，按该次要求执行，但不要把一次性覆盖写回长期默认。

### 模式 B: 转字幕

> 步骤 1-4 完成后，如果用户选了模式 B，执行以下步骤。
> **两步拆分**：先纠错，再断行。两步必须分开进行，不要混为一步。

#### B-1 提取纯文本（脚本执行）

```bash
node "$SKILL_DIR/scripts/extract_text.js" \
  "$BASE_DIR/1_转录/subtitles_words.json" \
  "$BASE_DIR/1_转录"
# 输出: $BASE_DIR/1_转录/raw_text.txt
```

#### B-2 第一步：纠错（AI 处理）

1. 读取 `$BASE_DIR/1_转录/raw_text.txt`
2. 读取 `$SKILL_DIR/用户习惯/纠错prompt.md` 规则
3. **只做纠错**，不断行、不去标点、不改格式
4. 输出到 `$BASE_DIR/2_纠错/corrected.txt`（每行一句，与输入 1:1 对应）
5. 如有「不确定清单」，输出到 `$BASE_DIR/2_纠错/uncertain.md` 并在对话中列出给用户

#### B-3 第二步：断行（AI 处理）

1. 读取 `$BASE_DIR/2_纠错/corrected.txt`
2. 读取 `$SKILL_DIR/用户习惯/断行prompt.md` 规则
3. **只做格式化**，不改字、不删字、不加字
4. 输出到**视频所在目录**：`$(dirname "$VIDEO_PATH")/subtitles_formatted.md`
5. 告知用户文件路径，流程结束

---

## 配置

默认记录本地 Python/WhisperX 环境、ASR/对齐/分段模型缓存路径、识别参数和源音频指纹。无需云端转录 API；受限模型首次下载可能需要 Hugging Face 访问授权，复用已有可离线加载缓存，不把授权凭据写入输出。旧云端脚本与 key 读取器保留作历史兼容；只有用户今后明确改用云端引擎时才检查它们，不能自动回到 flash/标准版轮流模式。

批注回调的 `model` 与 `reasoningEffort` 只作用于独立回调任务；未配置的独立混合批注 worker 默认 `gpt-6.1-sol`/`high`，现有明确配置保持原值；总控和各子任务按任务矩阵单独选择。以实际 CLI 参数和请求记录核对，不改全局 Codex 默认模型。
