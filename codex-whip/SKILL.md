---
name: codex-whip
description: 所有已授权执行、范围明确且有只读确定验收命令的任务，都必须由根 AI 在执行前自动登记；单文件或简单任务不例外，用户无需手工操作。通过 Stop hook 验收 gate 和 Codex CLI 有界监督循环推进。纯分析、待确认、暂停、缺外部输入、需要新授权、没有确定验收命令或自身是 worker 时不登记。
metadata:
  category: codex-ops
  status: canonical
---

# Codex Whip

根 AI 负责登记、监督与验收，CLI worker 只执行已允许的有界批次。使用前读取 [运行时接口与边界](references/runtime.md)。首次使用见 [安装说明](references/setup.md)。

需要规划时，按用户配置或显性指定的模型与入口制定方案，并在调用前告知用户；无需规划直接使用 Codex CLI，不因任务复杂强制增加规划。执行与验收使用 Codex CLI，确定性操作使用脚本或专用工具。

## worker 自检（最先判断）
满足任一即为 worker：环境变量 `CODEX_WHIP_WORKER=1`，或 prompt 首行是 `[codex-whip worker]`。
worker 不使用本技能，不调用任何 `codex` 命令，也不运行 whip.py；只执行交接里允许的步骤，按 worker 报告格式结束。

## 登记与执行

用户已授权执行、范围明确且根 AI 能写出只读、确定的验收 argv 时，根 AI 必须在动手前自动执行 init，无需用户手动登记。验收可以是测试，或纯文件、数据、网页、API 的只读回读。纯分析、待确认、用户暂停、缺外部输入、需要新授权或写不出确定验收命令时不登记，并说明原因；已登记后用户改为只分析或要求暂停，先 mark paused。

登记是执行前步骤，不因任务简单、只改一个业务文件或用户说“不新增其他文件”而跳过。“仅改 X”约束 workdir 内的业务文件；init 在注册目录生成必要状态不是新增业务文件，也不得向 workdir 添加额外文件。若用户明确禁止元数据写入本身，根 AI 应报告该冲突，不得静默跳过 gate。

```sh
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" init \
  --goal '目标' \
  --acceptance-json '["python3","-B","test_contract.py"]' \
  --allow source.py
```

ID 默认生成，workdir 默认当前目录的绝对路径。有 `CODEX_THREAD_ID` 时默认绑定；可用 `--bind-session SID` 显式绑定或 `--no-bind` 取消绑定。无会话 ID 时使用 init 输出的 `CODEX_WHIP_TASK` 绝对指针。未显式指定 `--effort` 时沿用 CLI 配置。

```sh
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" run --task TASK_ID
```

首次验收通过即完成、零 worker；否则前台 exec 后仅用真实 session ID resume。每轮最多 `--max-batches 1..4` 批（默认 4）；窗口用满、同因两次或无进展两次转入 needs_diagnosis，并非任务完成。Stop hook 不启动 worker；active 重复 Stop 转诊断并当次 block，needs_diagnosis 验收失败始终 block。

根 AI 收到诊断提示后先读失败证据，查明根因、换新方案，再执行：

```sh
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" diagnose \
  --task TASK_ID --cause '根因' --plan '与以往不同的新方案'
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" run --task TASK_ID
```

诊断保留总批次与 worker SID，只重置单轮窗口。默认最多 3 次诊断，可用 `--max-rounds N` 登记；用尽转 need_auth/budget，向用户请求追加后，使用 `diagnose --budget-approval '用户原话'` 追加一轮。不得自行批准、原样重跑方案或修改验收合同。真实阻塞、需要授权或用户暂停时先 mark，再结束。

diagnose 成功清除 trigger。未完成诊断时，即使先 mark paused、blocked 或 need_auth，再 mark active 仍恢复 needs_diagnosis，须先提交新诊断。hook 从 active 或 needs_diagnosis 新转 need_auth/budget、violation 或 blocked 时，当次 block 一次要求停止修改、向用户报告后结束；预算用尽须请求追加授权。下次 Stop 已是终止态才放行，验收通过 done 仍直接放行。

```sh
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" mark \
  --task TASK_ID --status paused --reason '用户要求暂停'
```

## 验收与边界

用 `check --task TASK_ID` 读取真实验收结果；用 `status --task TASK_ID` 查看状态。worker 的 DONE 不等于验收通过。验收脚本及 argv 中已有的非目标文件以 size/mtime_ns 保护，辅助模块用 `--protect PATH` 显式登记；保护文件不可命中 allow。直接 argv 里的目标输出可编辑，若需保护必须显式 `--protect`。保护文件改变转 violation，不改合同继续。越界写入和嵌套调用停止并交根 AI 处理。

根 AI 若既不 diagnose 也不 mark，失败 Stop 会持续 block 到用户中断；期间 hook 不派发 worker，也不修改验收。假 CLI 已覆盖文件/数据回读；网页与 API 的真实端到端验证须以当轮实测为准，不能据此声称已验证。

不扩大授权，不改账号、权限、launcher、MCP 或全局配置，不建 goal、服务或定时器。用户指定工具优先。只监测 workdir 内文件变化。运行时只为明确登记的任务提供 gate，不承诺任意聊天都必然继续执行。

## worker 报告格式

`DONE|BLOCKED|NEED_AUTH`、改动文件、执行的命令及结果、未完成项。

## 根 AI 收尾

完成时报告结果和实际验收；有阻塞时报告原因及所缺输入。请求模型或 effort 不代表实际遥测，没有真实回执时不推测 actual 值。
