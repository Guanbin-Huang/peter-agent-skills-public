# WhisperX 转录与说话人分段 v1

## 入口与边界

2026-09-29 用户明确要求：AI剪口播的转录分工使用 WhisperX，不再直接以 faster-whisper 作为入口。WhisperX 集成 faster-whisper ASR 后端、语言相关强制对齐和 pyannote 说话人分段；后端依赖保留，不单独卸载。只更新本 skill 及其路由，不擅自替换其他技能或重新转录已有视频。

## 执行链

1. **复用与预检**：绑定真实源音频指纹、源时间基与缓存。检查已安装 WhisperX 版本/API、ASR 模型、语言对齐模型、pyannote 模型可加载性。模型首次获取的 Hugging Face 授权和条款按实际需要处理；凭据仅通过现有凭据存储/进程环境读取，不打印或写进项目。MPS/CUDA 可用性按阶段检测，不把 WhisperX 的 CPU int8 设置误当作所有子模型的通用参数。
2. **ASR → align**：使用 `whisperx.load_audio`、`whisperx.load_model(...).transcribe`，再用 `load_align_model` 与 `align` 得到词级时间。复用同源有效的用户校对稿时保护文本，仅补必要对齐；未对齐词标记 missing_alignment，不能平均分配时间假装准确。模型与工具版本、语言、识别参数均入 manifest。
3. **diarize → assign_word_speakers**：双人/多人对谈显式调用 `whisperx.diarize.DiarizationPipeline`，随后 `assign_word_speakers(..., fill_nearest=False)`。已知且确认两位真实说话人时用 `num_speakers=2`；未知则让分段模型估计或使用有证据的人数范围，禁止所有视频硬填2。一个人演两个角色仍是一位声学说话人，角色通过视频/剧本证据另行映射。
4. **原声/画面核对后交接**：speaker 标签只是当前源内的声音簇，不是姓名，也不保证跨视频的 SPEAKER_00 是同一个人。由 Sol 结合声音、画面与用户确认信息核对角色；Luna 只整理已有标签和轮次。无可靠归属的词保留 unknown，重叠时间窗另记 overlap；即使自动返回单一 speaker，也须标记跨说话边界、抢话和低覆盖区间供回听。不要仅按词义推断人物，不把最近邻硬填当作已确认。
5. **验收与缓存**：保存原始 ASR、aligned words、diarization 区间、带 speaker 的结果、角色映射及待核对清单。双人对谈的新粗剪前应具备说话人结果；只完成 ASR 时状态为 partial，不报告“已分清两个人”。抽查两位说话人的清晰片段、轮次转换和已检测重叠处，未听校明确标注。源不变但缺 speaker 数据时只补 diarization/合并；改字不重跑整链。ASR、alignment、diarization 分别记录源指纹、模型/版本、参数，角色映射另记证据。

## 并行与失败处理

- WhisperX 属于专用模型工具链，不额外分派 GPT 做转录计算。分源可并行，默认先1路，核实 CPU/内存后最多2路起步；同源 ASR → align → 标签合并存在依赖。不要因字幕、封面、贴片三路需要文本而重复加载三套模型。
- 缺模型/授权/语言对齐支持或分段失败：保留已成功阶段与原始异常，修复对应阶段后续跑，不悄悄切回独立 faster-whisper 或云端转录，不把缺失 speaker 都填为同一人。
- 本机 2026-09-29 接口检查：WhisperX 3.8.6、pyannote.audio 4.0.7，`DiarizationPipeline` 使用 `token` 参数且支持 `num_speakers`，`assign_word_speakers` 支持 `fill_nearest`。安装版本可能变化，执行前核对本机签名，不照抄旧 `use_auth_token` 示例。
- 本机导入时存在 torchcodec/FFmpeg 动态库警告；当前 `DiarizationPipeline.__call__` 支持 ndarray。优先用 WhisperX/FFmpeg 解码并传入16kHz单声道 float32 波形，避免依赖 pyannote 内置文件解码；正式任务仍须实测短样本。导入成功不代表全链已跑通，本次规则更新不声称完成新音频转录。

可复用指令：
```text
按 AI剪口播 的 WhisperX 入口处理双人对谈：复用有效缓存，
依次完成转录、词级对齐、pyannote 分段和说话人标签合并。
仅在确认有两位真实说话人时固定人数2；保留 unknown/overlap，核对角色后再剪辑。
```

官方依据：[WhisperX](https://github.com/m-bain/whisperX)，已核对其 ASR 后端、pyannote 集成及重叠语音限制。此文档规定执行契约，不是自动启动的后台转录服务。
