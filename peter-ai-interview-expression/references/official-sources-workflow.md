# 官方资料 → 项目学习档案 → 面试逐字稿

## 1. 索引与版本

`official-company-sources.json` 是技能自带的公开来源快照，包含120个公司领域席位：具身中国30/美国30，Agent中国30/美国30。它不是完整历史文章数据库，也不是严格行业排名；机器人本体、基础模型、平台、企业软件和业务应用分层使用。同一领域按公司/母公司/品牌去重，跨领域可重复。

每条记录保留：`id`（稳定来源ID）、`domain`、`country`、`company`、`category`、`primary_url`、`docs_url`、`github_url`、`example_url`、`source_type`、`verification_status`、`checked_at`、`note`；可选`tier`、`supplemental_sources`、`latest_entry_check`及主体/总部依据。`example_url`是代表种子，不一定为最新文章。A/B及原状态是当次读取深度，不是公司可信度评分或个人掌握程度。

公开包默认使用 `references/official-company-sources.json` 的历史快照。若有自己维护的索引，可显式用 `--registry PATH` 传入，并比较更新时间与相关条目的读取状态；需要当前信息时在线核对，不把快照当成实时结论。

## 2. 两条领域路线分开，再定问题

- **Agent块**：先读 `agent-project-track.md`，筛 `domain=agent`，池内中国30＋美国30。
- **具身智能块**：先读 `embodied-project-track.md`，筛 `domain=embodied`，池内中国30＋美国30。
- 共用来源卡与证据规范，技术链、评估口径、实验和口述重点按track分别组织；只有明确跨域任务才对照两块。

### 先定问题再选源

把当前问题写成一句可验证的C，而不是“学某家公司的所有知识”。每批先选2–5家或材料，取得有效机制与证据后再按实际缺口增加。不因有120家就遍历120家。

| 项目缺口 | 主要路由 | 可先查的公司/材料种类 | 要带回的细节 |
|---|---|---|---|
| Agent工具/状态/记忆/可靠性 | Agent工程博客、SDK、API、代码与Issues | Anthropic、OpenAI、Google、Microsoft、AWS、LangChain、LlamaIndex、DoorDash | 输入输出、状态持有、工具成功与任务成功、重试/幂等、评估与版本 |
| VLA微调/数据/推理执行 | 具身模型指南、SDK、源码、报告与Issues | PI/openpi、NVIDIA/GR00T、智元、自变量、星海图及所用本体厂商 | schema/时间/动作表示、配置、版本、离线与闭环评估、部署接口 |
| 为什么这样做/业务取舍 | 官方业务工程正文与项目需求证据 | DoorDash、美团、京东、企业Agent平台和对应机器人业务案例 | 客户任务、质量定义、时延成本、协作/验收；缺真实数据则保留假设 |
| 复现bug/版本不兼容 | 精确所用仓库tag/commit、Issues/PR、设备SDK | 先定位实际依赖，再用对应厂商资料；July等中文实践补理解 | 最小复现、版本差异、假设区分实验、根因证据、修复及回归 |

公司名是入口，不是默认架构或能力保证。资料与实际使用的模型、本体、版本及任务不匹配时，记录不适用，不硬套到项目。

## 3. 只读相关入口

技能根目录执行示例：

```bash
python3 scripts/select_official_sources.py --domain embodied --query 微调 --limit 5
python3 scripts/select_official_sources.py --domain agent --company DoorDash
python3 scripts/select_official_sources.py --domain agent --company LangChain
python3 scripts/select_official_sources.py --kind materials --domain agent --company 美团
python3 scripts/select_official_sources.py --kind materials --domain embodied --query 数据 --limit 3
```

`--domain agent/embodied`必须显式指定；可选`--country 中国/美国`、`--company`（名称子串）、`--query`（分类/备注/来源类型的文本子串）、`--registry`（实际JSON路径）。筛选器只做文本匹配，空结果不表示不存在相关研究；必要时换明确公司或追官网导航。默认 `--kind companies` 保持公司入口筛选与原输出；`--kind materials` 筛 `tracked_materials` 的标题、技术摘要、项目用途和局限，结果在 `materials`。它不联网、不生成技术结论，也不改档案。

拿到入口后再实际读与问题相关的正文。论文读实验设置/消融/局限；代码定位相应实现与固定版本；工程博客提炼机制和取舍。目录/摘要、JS空页、失败、产品宣传各自记录，不能合并成“全文已核验”。官方报告自报指标也保留实验口径，不当作自己的测试结果。

## 4. 用来源卡完成结构化转化

按 `../assets/official-source-card.md` 建S卡。最小链路：

`问题/C → 选中的公司/来源ID → 原材料/S → 机制与适用条件 → 本项目关联 → 需要的实验/E → 档案条目 → 口述段落`

四类陈述分别保存：作者公开说了什么；我如何理解；我实际做了什么；我接下来建议验证什么。保留作者结论、自己的推断、项目证据和未知，不能以流畅口述消除差别。

| 材料处理 | 学习档案落点 | 逐字稿落点 |
|---|---|---|
| 官方机制/架构 | 技术主线、方案对照、S卡与版本 | 未做：我调研/阅读过；做过且有E：解释真实动作与取舍 |
| 官方业务经验 | 非技术地图、价值/成本/验收假设 | 用作判断依据或对比，不冒称同样客户/指标 |
| 复现/Issue线索 | Bug卡，建议→实验→根因→回归状态 | 仅线索：我准备验证；有本人的闭环证据：讲实际解决事件 |
| 教学类比 | 机制解释区，显式“教学例子” | 说明概念，不变成第一人称真实经历 |

只读到一家公司文章，支持“我读到/对比了”，不支持“我设计/部署/提升了”。先更新档案中C/E/S和补证任务，再同步面试稿；来源ID不塞进口述正文，放附录映射。

## 5. 快照读取范围与持续更新

2026-10-05 快照增加6条具体材料：5条 `old_backfill`（旧文补录）、1条 `date_unconfirmed`（发布日期待核），不是6条新发布。公开快照的 `read_scope` 记录历史已读范围；原始索引若无此字段，按 `evidence_path_or_method` 与 `limitations` 回查，不凭 `body_read` 补出全文范围。`limitations` 保留未审阅图表、章节限制及未复现状态；`reading_status=body_read` 不等于全文通读或本次重新核读。更新时间、首次发现时间、发布日期分别记录。

`coverage` 保留120席位已尝试、101席位全入口成功/19部分成功、22个入口待核，以及 `article_enumeration_complete=false`、`all_source_reads_complete=false`。入口成功不等于全站文章已枚举、正文全读或厂商指标已复现；公司条目的 `latest_entry_check` 保留入口范围与失败状态。公开包没有本机取证路径、账号或任务遥测。

需要把执行语义、根因排障、业务取舍转成可追问证据时，读 [项目研究深化](project-research-playbook.md)，再按来源卡映射 C/E/S。


来源快照可以按用户需求手动更新，也可以由用户自己已有的外部同步流程更新。安装本包不创建定时任务、账号或订阅。更新仅同步公开来源目录，保留来源 ID、日期和实际读取状态；不自动改写用户已确认的简历或项目经历。

交付前检查：所选来源来自实际索引且与问题相关；日期/版本/已读范围明确；技术与非技术缺口按需覆盖；S不代替本人E；两份产物的职责、版本、数字一致。快照容量达标不等于正文全读、复现成功或项目验收成功。
