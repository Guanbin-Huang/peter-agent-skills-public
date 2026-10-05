# 项目研究深化：从支持材料到可追问证据

只在项目存在技术理解、复现排障或非技术交付缺口时读取。本页将已有研究整理为问题路由，不要求完成所有阅读或为项目增加新组件。先选 Agent 或具身智能，再处理一个具体 C；外部 S 不替代 E。

## 1. 按问题找材料，不按平台凑数量

| 要回答的问题 | 先读什么 | 带回档案的产物 |
|---|---|---|
| 为什么这样设计 | 原论文/technical report 的方法、附录、消融与失败 | 假设、替代方案、适用条件、不能支持的结论 |
| 接口或函数实际做什么 | 官方源码固定 commit/tag、测试；HF 模型/数据卡对应 revision | 输入输出、调用路径、状态变化、配置与代码定位 |
| 为什么复现失败 | 实际依赖的 Issue/PR、HF 讨论，再对照自己的日志 | 环境、最小复现、区分假设的实验、修复版本与回归 |
| 中文解释或近期争议 | July CSDN、知乎、作者博客、X；再追一手材料 | 原作者、直接来源、版本、自己的理解，未读正文明确标记 |
| 机器人接口/控制器行为 | 实际本体 SDK、固件文档、ROS/MoveIt/ros2_control、厂商论坛 | 单位/坐标/频率、控制权、接收与执行状态；论坛只是线索 |

OpenReview 用于公开评审与作者回复；读不到评审就只记录入口。Robotics Stack Exchange、Open Robotics Discourse、Universal Robots Forum 用于具体问题；Discord、Reddit、ModelScope、微信群等仅在已有相关线索时补查。渠道存在不表示本次已读、账号可用或结论成立。

社区分工来自历史有限样本：Xbotics 可优先找论文/开源导航与同行排障线索，机友圈儿可优先找客户、成本、协作与验收语境。先确认实际可读材料，不假定购买或答疑服务；付费正文与个人聊天不进入公开包。点赞、感谢或关闭 Issue 不证明本人已修复。

## 2. Agent：从工具结果追到任务结果

先检查输入 schema、信息是否齐备、时间规范化、状态持有、工具参数和副作用。分别记录“模型说成功”“工具返回成功”“目标状态实际改变”“用户任务验收”，不得合并。

| 支持材料入口 | 可以支持的问题 | 不能代替什么 |
|---|---|---|
| [ToolSandbox 论文](https://aclanthology.org/2025.findings-naacl.65/) / [作者仓库](https://github.com/apple-aiml-research/ToolSandbox) | 有状态依赖、信息不足与多步工具交互怎样评测 | 本人系统的覆盖率与线上效果 |
| [τ-bench v1](https://arxiv.org/html/2406.12045v1) | 为什么检查最终数据库状态，而不是只听模型回答 | 自己项目的实际任务结果 |
| [AWS 幂等重试](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) | 响应丢失后如何避免重复副作用 | 所用 API 已实现幂等的证据 |
| [美团 Agent 评测](https://tech.meituan.com/2026/08/07/Agent-Evaluation.html) | 任务、预期行为、执行轨迹、案例归因与回归 | 所有业务都适用同一指标的证明 |

以上入口沿用历史研究，并非本次逐篇重新验证。当前快照另含美团评测白皮书、Strands 固定选项决策和 Anthropic 执行隔离材料，用 `--kind materials --domain agent` 查对应原文、历史读取范围及局限。不要因文章出现多 Agent、记忆或沙箱，就宣称本人实现了这些组件。

最小验证先用一个成功样例与一个工具成功但任务失败的样例，记录真实输入、工具 Trace、最终状态和验收规则。涉及 Pass@k 与单次通过率时分别定义分母与试验次数，不混算。未执行的测试写待验证。

## 3. 具身智能：算法、推理运行时与控制器分开

| 研究主线 | 一手入口 | 应追问的区别 |
|---|---|---|
| VLA 数据、状态与动作表示 | [openpi](https://github.com/Physical-Intelligence/openpi)、[OpenVLA](https://github.com/openvla/openvla)、[LeRobot 文档](https://huggingface.co/docs/lerobot) | 图像/本体状态/语言对应时刻；动作的单位、坐标、归一化与部署约定 |
| 异步动作块衔接 | [RTC v1](https://arxiv.org/html/2506.07339v1) / [作者仿真实验](https://github.com/Physical-Intelligence/real-time-chunking-kinetix) | 预测步数、执行步数、重规划周期、推理延迟与已承诺动作 |
| 人工干预与奖励 | [HIL-SERL](https://arxiv.org/abs/2410.21845) / [作者仓库](https://github.com/rail-berkeley/hil-serl) | 人工替换动作、干预数据、奖励模型是不同组件；视觉 RL 不等于 VLA 本体 |
| VLA 引导在线 RL | [RLT v1](https://arxiv.org/html/2604.23073v1) / [RLinf 文档](https://rlinf.readthedocs.io/en/latest/rst_source/examples/embodied/rlt.html) | 原论文 π0.6 与社区 π0.5 复现分开；人工标签不自动变成分类器；条件化动作块不随意改称残差 |

这些是历史研究入口；引用时重新核对适用版本、实际已读章节及是否复现。后续 RTC/动作连续性论文若只读摘要，就保持摘要线索，不写成已解决所有闭环问题。

### 历史源码例子：暂停、重置、过期结果与机械运动

LeRobot 历史静态源码基准为 `84b6993033b539d5d46918aa769b83c95998651b`，不是“当前 main”，也不是学员项目的运行证据：

- [`pause/reset`](https://github.com/huggingface/lerobot/blob/84b6993033b539d5d46918aa769b83c95998651b/src/lerobot/rollout/inference/rtc.py#L327-L358)：暂停活动与重置处理器、队列、观测和 epoch 分开解释。
- [过期结果检查](https://github.com/huggingface/lerobot/blob/84b6993033b539d5d46918aa769b83c95998651b/src/lerobot/rollout/inference/rtc.py#L580-L588)：重置后旧推理晚返回，不能仅靠“清过队列”判断其会被丢弃。
- [任务文本切换](https://github.com/huggingface/lerobot/blob/84b6993033b539d5d46918aa769b83c95998651b/src/lerobot/rollout/inference/rtc.py#L485-L492)：切任务、人工接管、暂停和重置不是同一动作。
- [SmolVLA 动作缓存](https://github.com/huggingface/lerobot/blob/v0.4.4/src/lerobot/policies/smolvla/modeling_smolvla.py#L323-L351)：传入新观测不自动证明每次都重新生成动作块。

应用队列、模型推理、控制器已接收目标和机械运动分别取证。清队列不证明控制器撤销目标；推理 Hz 不等于控制 Hz；指令发送、接收、运动完成、任务成功分别确认。最小验证先检查实际版本源码和已有日志；真实设备试验依设备文档与授权进行，不把未验证论坛建议直接用于硬件。

把五类追问写入档案：数据的时刻/shape/单位；预测与执行的节奏；控制权与失效规则；反馈与完成判据；哪些来自 S、哪些有本人 E。VLA 微调另外绑定数据切分、episode 边界、mask、统计、checkpoint、评测配置，离线/仿真/真机结果分开。

## 4. 非技术：从需求到交接，而不是背部门名

| 主线 | 要补的本人证据 | 外部方法入口与边界 |
|---|---|---|
| 需求/价值 | 需求基线、相关方、成功标准、替代方案；ROI 未测就列假设 | [NASA 系统设计](https://www.nasa.gov/reference/4-0-system-design-processes/)：借鉴需求澄清，不当作公司内部制度 |
| 责任/接口 | 谁决策、实现、验收；ICD、上下游依赖、阻塞与会议决定 | [NASA 技术管理](https://www.nasa.gov/reference/6-0-crosscutting-technical-management/)：按项目规模裁剪 |
| 资源/变更 | 排期、算力/设备/人员冲突、供应商交期、变更影响与批准 | [PMI 需求管理](https://www.pmi.org/learning/library/mastering-project-requirements-planning-controlling-closing-5814)：历史方法文章，不冒充最新版标准 |
| 验收/交接 | FAT/SAT 或软件验收用例、签字/确认者、遗留项、培训和维护责任 | 方法来源不能证明本人完成验收；Demo 视频不等于验收包 |
| 故障/复盘 | 问题定义、临时遏制、根因实验、永久改进、责任人和关闭证据 | [ASQ 8D](https://asq.org/quality-resources/eight-disciplines-8d)、[Google SRE 复盘](https://sre.google/workbook/postmortem-culture/)：框架不替代本次根因，软件经验迁移到现场需调整 |

脑图或资料目录仅提供候选检查清单。分别标“主题已列”“有支持材料”“做过”“验收通过”；硬件/标定、规划力控、PLC、跨组联调、多机交付缺资料时标待补，不用 Agent/VLA 文献宣称全覆盖。没有客户证据，不凭公开案例编造客户、收益或本人权限。

## 5. 同步到学习档案与逐字稿

每次只推进这条链：`项目问题/C → 原文与固定版本/S → 来源卡 → 机制与条件 → 本人动作/E 或待验证实验 → 档案落点 → 口述段落`。纯阅读用“我调研/比较了”；实际实现与修复要有对应日志、变更和同条件回归。外部指标保留作者及实验口径，不写成本人结果。

```text
请使用 Peter Expression 整理这个项目的研究缺口。
先定 Agent 或具身智能，再选当前最重要的一条主张；只查相关材料。
区分原作者结论、静态源码证据、社区报告、我的理解和本人实际实验。
每项给原链接、日期/版本、已读范围、支持什么、不支持什么、最小验证。
同时核对需求、责任、资源、验收和交接证据；缺失项保留待补。
先更新项目学习档案，再同步可口述面试稿；S 不替代 E，不编造指标或责任。
```
