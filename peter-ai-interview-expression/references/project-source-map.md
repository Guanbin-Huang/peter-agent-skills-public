# 资料源路由：用来支持主张，不代替经历

这是可选的检索入口，不是实时可信度排名。每次使用核对内容、日期和对应软件版本。只在具体问题需要时读取，不要求逐个搜索所有平台。

| 来源 | 主要用途 | 核验要求 |
|---|---|---|
| 原论文、arXiv technical report、项目附录、OpenReview | 方法、实验设置、消融、局限及评审争议 | 区分作者结论、审稿意见、自己的推断；版本/数据/评价口径一致 |
| 官方 GitHub、Issues/PR/Discussions | 实现、依赖、版本差异、复现 bug 和修复 | 固定 commit/tag；确认修复适用版本；不把当前 main 当用户环境 |
| Hugging Face 模型卡、数据卡、文档、讨论 | 权重、数据格式、训练/推理配置、社区复现 | 区分官方维护与社区帖子，核对模型和数据 revision |
| CSDN、知乎、团队技术博客（如美团） | 中文推导、工程案例、解释和排查线索 | 追到原材料；原创实践与转载/观点分开；不只用热度评价 |
| X.com、作者主页、社区交流 | 发现新报告、作者澄清、负面结果和更新线索 | 回到报告/仓库验证，不以短帖替代完整实验 |

## 可读网站总览

用户要具体网站或图示时读 [信息源网站地图](information-source-map.md)，Agent与具身分别列用途及具体URL；另含120席位完整表。它是机器索引的可读快照，不修改实际读取状态。

## 内置官方公司资料库（项目写作优先）

先读 `official-sources-workflow.md` 并用 `../scripts/select_official_sources.py` 在 `official-company-sources.json` 中局部选源。120席位由具身智能与Agent各60组成，每个领域中国30、美国30；公司跨领域可重复。

官方来源进一步分为工程博客、技术指南/SDK、研究论文/technical report、开源实现、产品概览。与待验证问题匹配的官方正文优先；官方新闻或产品概览不自动具有训练/架构/根因证据。July CSDN、知乎、HF社区、X和知识星球仍保留为解释、发现与排查补充渠道，外部社区不覆盖官方原材料。

## 可选中文解释源：July CSDN

优先检索 [v_july_v](https://blog.csdn.net/v_july_v) 与当前问题直接相关的文章；保留作者解释和实践的适用范围，不默认所有内容都已验证。

- [π0 微调与 openpi 实践](https://blog.csdn.net/v_JULY_v/article/details/146125555)
- [openpi 源码相关解析](https://blog.csdn.net/v_JULY_v/article/details/146068251)
- [LeRobot π0 封装相关解析](https://blog.csdn.net/v_JULY_v/article/details/148370072)
- [RTC 与动作分块相关解析](https://blog.csdn.net/v_JULY_v/article/details/149352338)

这些入口作为相关主题的示例；页面标题、正文、更新时间及代码有效性在引用时重新读取，不能把这里的链接当作已完成本轮验证。

## VLA 常用一手入口

- [openpi](https://github.com/Physical-Intelligence/openpi)：训练、微调、数据与策略服务；按实际选用模型走官方说明。
- [OpenVLA](https://github.com/openvla/openvla)：对应路线的实现与微调。
- [LeRobot](https://github.com/huggingface/lerobot) 与 [HF 文档](https://huggingface.co/docs/lerobot)：数据、训练、部署及社区 Issue。

## Xbotics 与机友圈儿

Xbotics、机友圈儿等社区仅作为可选的论文/开源导航、排障或行业讨论线索。用户提供可访问材料或已有对应读取工具时，再按具体问题读取；不假定购买、访问权限、答疑承诺或服务已配置。引用具体帖子时标明原作者、已读评论与附件范围，不能把目录存在或感谢回复当作修复证据。

私人材料与付费正文不复制进可公开技能或公开样例。附件未读写未读，读取失败写失败，抽样不写全量。

## 按需深化与社区分工

技术机制、复现 bug、动作执行与非技术交付缺口读 [项目研究深化](project-research-playbook.md)，包括固定版本的暂停/重置/过期推理结果、需求与接口责任、资源变更、FAT/SAT 与交接证据。

历史有限样本中，Xbotics 偏论文/开源导航和同行排障线索，机友圈儿偏客户、成本、协作与验收语境；不是社区全量评价或答疑承诺。引用时仍核对具体可读材料和本人验证。NASA/PMI/ASQ/SRE 方法源支持项目管理思路，不证明本人职责或公司内部制度。
