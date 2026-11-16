# Codex Whip 运行时

运行时使用支持 `Popen(process_group=0)` 的 Python 3.11+，以标准库实现，分为 Stop 验收 gate 与前台 run 监督循环。它只对明确登记且具有确定验收 argv 的任务生效；纯分析、待确认、暂停、缺外部输入、需新授权和未登记聊天不进入循环。验收命令必须可信、只检查结果，使用 `python3 -B` 避免写入字节码。

## 接口

```sh
python3 -I scripts/whip.py init [--id ID] [--workdir /absolute/workdir] \
  --goal '目标' --acceptance-json '["python3","-B","/absolute/check.py","{workdir}"]' \
  --allow source.py --allow 'package/*.py' [--protect /absolute/helper.py] \
  [--max-batches 1..4] [--max-rounds N] [--effort medium] [--bind-session [SID]|--no-bind]
python3 -I scripts/whip.py diagnose --task ID --cause '根因' --plan '新方案' [--budget-approval '用户原话']
python3 -I scripts/whip.py run --task ID
python3 -I scripts/whip.py check --task ID
python3 -I scripts/whip.py status --task ID
python3 -I scripts/whip.py mark --task ID --status paused --reason '用户要求暂停'
python3 -I scripts/whip.py stop-hook
```

方括号表示可选参数，不是实际 shell 输入。根 AI 判断用户已授权执行、范围明确且能写出只读确定验收命令后，必须在动手前自动 init，无需用户手动登记。不保证识别任意自然语言任务；写不出验收命令时不登记，并说明原因。纯分析、待确认与暂停不登记，已登记后转为分析或暂停先 mark paused。

登记是执行前步骤，所有符合条件的任务都必须登记；任务简单、单文件或“不新增其他文件”均不豁免。“仅改 X”约束 workdir 内的业务文件；init 在注册目录生成必要状态不是新增业务文件，也不得向 workdir 添加额外文件。若用户明确禁止元数据写入本身，根 AI 应报告该冲突，不得静默跳过 gate。该协议由根 AI 履行，不保证任意自然语言都能被识别。

ID 默认 `t-YYYYmmdd-HHMMSS-xxxx`，workdir 默认 cwd 的绝对路径。有 `CODEX_THREAD_ID` 时默认绑定；`--bind-session` 无参数时使用该变量，给参数时绑定指定 session；`--no-bind` 禁用绑定。同一 session 的旧任务 active 或 needs_diagnosis 时拒绝抢绑；终止态（包括 paused、cancelled）可重新绑定，旧 task.json 保持不变。未绑定时用 init 输出的 `export CODEX_WHIP_TASK=/absolute/path/task.json` 显式激活。只查此指针或事件 session 对应 binding，不扫描任务、不猜路径、不认领自然语言文本。

`--allow` 可重复，匹配相对 workdir 的 POSIX 路径，采用 Python `fnmatchcase` 语义（`*` 可以匹配 `/`）；路径不可绝对或包含 `..`。把允许范围缩到任务必要文件。workdir 必须存在且是绝对路径。验收为非空字符串 argv 列表，不通过 shell 执行；参数中的 `{workdir}` 替换为登记的 workdir。登记 ID 唯一，不复用既有任务目录。`--effort` 只有显式提供时才传局部 `-c model_reasoning_effort="…"`，不设置模型。

`CODEX_WHIP_HOME` 覆盖任务注册根目录，默认 `~/.codex/whip`；测试通过此变量隔离状态。`CODEX_WHIP_CODEX_BIN` 可覆盖 CLI 可执行路径；通常使用 `PATH` 中的 codex。不要把验收 fixture 或本运行时测试放进 worker 的写入范围。

验收支持纯文件、数据、网页和 API 的只读回读，不局限于代码测试。登记时记录 argv 中已有非目标文件与 `--protect` 文件的 `(size, mtime_ns)`，每次 accept 前比对，改变或删除返回 tampered，run/check/hook 记 violation。验收执行文件不能命中 allow；直接 argv 中的目标输出不会自动保护，需保护时使用 `--protect`，显式保护与 allow 重叠直接拒绝。辅助模块不会递归发现，需要逐个 `--protect`。这是外部验收边界检查，不锁定任务输出，也不自动修改合同。网页/API 回读命令须使用真实认证协议；假 CLI 的文件回读测试不能证明网页/API 真实 E2E 已通过。

## 数据与状态

```text
HOME/tasks/ID/task.json       登记内容；运行时不再修改
HOME/tasks/ID/state.json      运行状态；state.lock 保护、临时文件原子替换
HOME/tasks/ID/run.lock        非阻塞 flock，防重复监督运行
HOME/tasks/ID/hook.log.jsonl  已关联的有效 gate 判定，含 session_id、turn_id 与真实验收
HOME/bindings/SID.json        显式 session → 任务 ID
TMPDIR/codex-whip/ID-*/       每次登记的独立产物目录，task.json 中 run_dir 为准
```

产物包括 `handoff-N.md`、`events-N.jsonl`、`stderr-N.log`、`last-N.md`、`exit-N`，以及 `orig/` 中登记时允许文件的 original bytes 备份。状态保存真实 worker session、批次、验收输出、停止原因和 Stop 计数。

只有 active 可派发；active 和 needs_diagnosis 均可 block。终止态为 done、blocked、need_auth、paused、cancelled、violation、nested。needs_diagnosis 为非终止态，run 返回 5 且不派发。state 新增 window_batches、diagnoses、trigger、extra_rounds、hook_epoch、unanswered_blocks；旧 state 缺字段时补默认值，window_batches 默认取 batches，其余为 0、空列表或 null。batches 只增不减，session_id 与 worker_sessions 保留。

`mark` 支持 paused、blocked、need_auth、cancelled、active，要求 reason，并清零 unanswered_blocks。active 只允许从 paused、blocked、need_auth 恢复；若 trigger 非空，恢复为 needs_diagnosis，并提示先 diagnose，不跳过未完成诊断。needs_diagnosis 必须 diagnose，need_auth/budget 必须带用户追加授权 diagnose。`check` 只执行一次验收并保存 last_accept，不重新激活暂停任务；验收超时或无法启动记 blocked。

`diagnose` 要求非空根因与不同于历史的新方案（空白规范化后比较）。它保存触发原因、总批次、失败尾部、根因、方案、时间与用户授权原话，恢复 active，将 trigger 清为 null，清零窗口、同因、无进展和 Stop 计数；保留总批次与 SID。默认最多 `--max-rounds 3` 次诊断，用尽转 need_auth，auth_kind=budget。用户明确追加后用 `--budget-approval '用户原话'` 增加一轮；根 AI 不得自行授权。hook 不消耗诊断轮次。

| run 退出码 | 含义 |
| --- | --- |
| 0 | done；已暂停或取消的任务不执行 |
| 3 | blocked，包括验收/worker 超时、缺失或不一致的 session |
| 4 | need_auth |
| 5 | needs_diagnosis，根 AI 须诊断后继续 |
| 6 | violation 或 nested（含 needs_review） |
| 64 | worker 禁止调用或输入/用法错误 |
| 75 | 已有 run 在途 |

## run 的有界监督

`run` 拒绝 `CODEX_WHIP_WORKER=1`。先取得 run.lock，再检查状态与真实验收；首次通过即 done，不派发 worker。只执行已登记的允许范围，不扩大授权或验收标准。

首次派发命令为：

```text
codex exec --sandbox workspace-write --cd WORKDIR --skip-git-repo-check --json -o LAST [effort] -
```

续派命令为：

```text
codex exec resume --skip-git-repo-check --json -o LAST [effort] SID -
```

交接从 stdin 输入；子进程在 workdir 前台运行，stdout/stderr 保存日志。worker 环境设置 `CODEX_WHIP_WORKER=1`，去掉 `CODEX_WHIP_TASK`，其余环境与现有 CLI 配置沿用。resume 不传 `--cd`、`--sandbox`；不传 `-m`，不改变 MCP、账号、权限、审批或全局配置。

每批事件必须有唯一真实 `thread.started.thread_id`，续派必须与原 session 一致；缺失或不一致立即 blocked，不猜 ID、不另开 session。验收成功才 done；worker 的 DONE 不能代替验收。验收仍失败时，检查报告首尾非空行，去除 Markdown 前缀后识别 BLOCKED、NEED_AUTH 及其后冒号、竖线或空白分隔的说明；NEED_AUTH 优先，命中即写入对应终止态并停止派发。

每轮窗口最多 `--max-batches 1..4` 批（默认 4）；窗口用满触发 batch_window，连续两批同因失败触发 same_cause，连续两批允许文件 bytes 未变且验收输出未变触发 no_progress。均转 needs_diagnosis；已用完诊断预算则转 need_auth/budget。单轮上限不是完成。交接追加当前诊断与已尝试方案，继续使用同一 SID resume。

验收失败原因以退出码和规范化后的输出字符串直接比较；耗时与十六进制地址做常见噪声归一化。worker 非零退出以真实退出码和 stderr 比较。文件遍历用 `os.walk` 剪枝跳过 `.git`、`node_modules`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`，不读取这些子树。允许文件直接比较批次前后的 bytes，包括新增与删除；其他文件只比较 `(size, mtime_ns)` 检测越界，不算任务进展。验收默认超时 60 秒，worker 默认 1800 秒；超时记录 blocked，不当作成功。验收与 worker 均通过 `Popen(process_group=0)` 在当前 session 内创建独立子进程组并同步 `communicate(timeout)`；超时时向该组发送 SIGKILL，再回收进程与输出，清理仍持有管道的后代。不使用新 session、detach 或后台服务。

## 命令与范围检查

只从真实 `item.started` / `item.completed` 中 `command_execution` 的 `command` 字段分析实际启动命令，按 item ID 与命令去重。解析常见 shell `-c` / `-lc` 包装、管道/连接符、环境赋值和 env/exec/command 前缀；可执行位置是 codex 或 whip.py run 则 nested。可执行位置使用变量间接调用时记 needs_review 并停止，由根 AI 核对。echo、文档正文、日志和代码字符串里的 codex 字样不构成嵌套。此检查不使用 eval，也不是完整 shell 解释器。

范围检查只覆盖 workdir 内未被剪枝的文件：allow 命中项比较 bytes，其余项比较 size 与 mtime_ns；超出 allow 的变化置 violation；不监控整台机器、不证明 workdir 外没有写入，也不替代 CLI sandbox。发现越界只停止并保留证据，不自动回滚用户文件。

## Stop hook 契约

stdin 为 JSON 事件，使用 `session_id`、`turn_id`、`stop_hook_active`；stdout 始终只输出一份合法 JSON，错误写 stderr。hook 不启动 LLM、不调用 run、不输出 `continue:false`。

未登记、worker 环境、缺失/不匹配的 parent session、已知 worker session、终止态或 run 在途时返回 `{}`。任务关联只通过显式指针或 session binding。

active 任务验收通过即保存 done 并返回 `{}`。失败返回 `{"decision":"block","reason":"…"}`，包含任务 ID、真实验收退出码、带 workdir 且使用 shlex.join 引用的准确验收命令、最多 20 行输出尾部和修复/run/mark 路径。hook 从 active 或 needs_diagnosis 新转 blocked、violation 或 need_auth/budget 时，当次 block 一次并写 hook.log，明确要求停止修改、向用户报告原因后结束；预算用尽还要求向用户请求追加诊断授权。下次 Stop 已是终止态才返回 `{}`，不再验收或消耗诊断轮次。

epoch 为 batches + 诊断次数。active 下 `stop_hook_active` 为真、同因且同 epoch，或窗口内 block 计数达到 `max_batches + 2`，转 needs_diagnosis 并当次 block；诊断预算用尽则转 need_auth/budget，当次 block 通知、下次放行。needs_diagnosis 验收失败始终 block，包括重复 Stop。诊断模板列触发、总批次、诊断次数/预算、失败尾部、准确验收命令，要求根 AI 读证据、diagnose 新方案后 run，或因真实阻塞/需授权/暂停先 mark。每次 block 将 unanswered_blocks 加 1，写 state 与 hook.log，仅留证据，不因次数多放行。

| 状态/验收 | 结果 |
| --- | --- |
| active 或 needs_diagnosis，通过 | done，`{}` |
| active，失败 | block；重复或计数上限转诊断并 block |
| needs_diagnosis，失败 | 始终 block |
| 保护文件改变 | violation，当次 block 要求报告，之后 `{}` |
| 验收超时或无法执行 | blocked，当次 block 要求报告，之后 `{}` |
| hook 新转 need_auth/budget | 当次 block 要求请求追加授权，之后 `{}` |
| 终止态、未登记、worker | `{}` |

已知局限：根 AI 若既不诊断也不 mark，续跑会持续到用户中断或要求暂停，期间 hook 不派发 worker，也不修改验收。Interrupt 后状态仍保留，若希望停下应由根 AI mark paused。Codex 是否有未公开的连续 block 上限，需真实 E2E 观察。

## 安装、测试与卸载

按本包 [安装说明](setup.md) 复制技能、注册 Stop hook 并添加根 AI 登记协议，保持既有其他 hooks 并核对启用与信任状态。真实 CLI E2E 应验证自动登记、非代码回读、先 block 后由根 AI diagnose 再 resume 同 SID 完成，以及暂停/未登记分析放行；静态或假 CLI 测试不等于真实 E2E。本包单元测试不运行真实 CLI、网页或 API E2E。

```sh
python3 -B scripts/test_whip.py
```

此测试使用临时 Python 假 CLI，不会调用真实 Codex。撤销安装时移除本 Stop hook 及对应信任条目，从安装前备份恢复 skill 与 AGENTS；不删除其他 hook。不需要自动清除任务产物；按保留要求自行归档后删除。
