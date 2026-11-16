# Codex Whip 安装与使用

目录：[环境与安装](#环境与安装) · [Stop hook](#stop-hook) · [根 AI 登记协议](#根-ai-登记协议) · [调用与验证](#调用与验证) · [卸载](#卸载)

## 环境与安装

支持 macOS / Linux 的 POSIX 环境，需要 Python 3.11+、可用的 Codex CLI 与现有登录状态。运行时依赖 `fcntl.flock`、POSIX 信号和 `Popen(process_group=0)` 子进程组，不支持 Windows。超时会终止该子进程组；不创建后台服务。

当前真实 CLI 验证版本为 `0.169.0-alpha.11.1`；不承诺所有 CLI 版本兼容。安装前核对本机 Python、CLI 版本，以及该版本的 hook 配置、启用和信任方式：

```sh
python3 --version
codex --version
codex --help
```

从公开仓库根目录复制本包。尚未取得仓库时执行：

```sh
git clone https://github.com/Guanbin-Huang/peter-agent-skills-public.git
cd peter-agent-skills-public
```

在仓库根目录执行以下命令；已有目标时只提示，不覆盖：

```sh
mkdir -p "$HOME/.codex/skills"
if [ -e "$HOME/.codex/skills/codex-whip" ] || [ -L "$HOME/.codex/skills/codex-whip" ]; then
  printf '%s\n' '目标已存在：先备份，再人工合并。'
else
  cp -R codex-whip "$HOME/.codex/skills/codex-whip"
fi
```

已有目标时，可先执行以下备份，再逐项人工合并本包文档和脚本；不要直接覆盖已有技能：

```sh
cp -RP "$HOME/.codex/skills/codex-whip" \
  "$HOME/.codex/skills/codex-whip.backup-$(date +%Y%m%d-%H%M%S)"
```

修改 hook 配置或根 AGENTS 前也保留备份。所需资源均在本包：`SKILL.md`、`scripts/whip.py`、`scripts/test_whip.py`、`references/runtime.md` 与本安装说明。无需额外 installer 或安装源。

可交给根 AI 的安装 prompt：

```text
请从我提供的 peter-agent-skills-public 仓库安装 Codex Whip（slug codex-whip）。
先读 codex-whip/references/setup.md 和 runtime.md，检查本机 POSIX、Python 3.11+、Codex CLI 版本与 hook 支持。
只复制到 ~/.codex/skills/codex-whip；已有目标先备份并人工合并，不覆盖。
备份并合并 ~/.codex/hooks.json 的 Stop hook，保留其他 hooks；按本机 CLI 确认启用和信任，不猜配置键。
将本安装说明的根 AI 登记协议合并到 ~/.codex/AGENTS.md，保留其他规则；不要加入个人模型偏好。
遵守本机已有写锁规则。不改账号、权限或全局环境变量配置。
执行本包单测，并在独立临时工作目录做真实 CLI 验证：自动登记、Stop block、根 AI 诊断后同 SID resume、最终验收，以及暂停和未登记分析放行。
仅使用真实 CODEX_THREAD_ID 或 init 输出的 CODEX_WHIP_TASK；记录实际结果，不把单测当作真实 E2E。
报告安装位置、实际验证与未决项；缺权限或需新授权时说明并停下。
```

## Stop hook

当前格式在 `~/.codex/hooks.json` 中使用 `hooks.Stop` 数组，每个 entry 含 `hooks` 数组。配置示例为有效 JSON：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 -I \"$HOME/.codex/skills/codex-whip/scripts/whip.py\" stop-hook",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

已有配置时仅合并上述 command hook，保留其他事件和已有 Stop entries，不整份替换。`$HOME` 由执行命令的 shell 展开；不要把它当 JSON 环境变量替换语法。按本机 CLI 的文档与实际状态确认 hook 已启用、命令已受信任；不同版本可能需要重新加载会话，不在这里假定通用开关键。

Stop hook 只执行验收并返回 gate 判定，不派发 worker。根 AI 负责登记、执行、诊断与向用户报告。未登记聊天不会自动获得持续执行保证。

## 根 AI 登记协议

将下面片段合并到实际生效的根 `~/.codex/AGENTS.md`，保留其他约定：

```markdown
## Codex Whip

- worker（CODEX_WHIP_WORKER=1 或 prompt 首行 [codex-whip worker]）不得调用 codex、whip.py 或递归派发 worker；只执行交接允许的步骤并报告。
- 根 AI 在用户已授权执行、范围明确且能写出只读、确定的验收 argv 时，必须在修改前读取 ~/.codex/skills/codex-whip/SKILL.md 并自动 init；简单或单文件任务也登记，无需用户手工操作。只分析、待确认、暂停、缺输入、需新授权或无法确定验收时不登记并说明原因；已登记后转分析或暂停先 mark paused。
- init 默认生成 ID，使用 cwd；只有真实 CODEX_THREAD_ID 才绑定会话，禁止捏造。没有真实会话 ID 时使用 init 输出的 CODEX_WHIP_TASK 绝对指针，并确认根 CLI 与 hook 实际取得该变量。独立 CLI 子进程不保证继承自定义变量；不要为此改全局环境配置。
- 根 AI 使用 run 推进允许范围内的有界批次，真实 SID 由 CLI 事件取得并用于 resume；worker 的 DONE 不代替验收。Stop 只做 gate，不派发 worker。
- 窗口用满、同因或无进展转 needs_diagnosis，不等于完成。先读失败证据、查根因并制定不同于历史的新方案，diagnose --cause … --plan … 后再 run；保留总批次与 SID，不原样重跑旧方案。
- 保护登记时的验收合同、验收脚本与显式 --protect 文件，不通过改合同、保护文件或放宽范围让验收通过。仅改某业务文件不禁止注册目录写入必要元数据；若用户禁止元数据本身，先报告冲突。
- 真实阻塞、需要新授权或用户暂停时先 mark blocked、need_auth 或 paused 并给出 reason，再向用户报告。诊断预算用尽必须请求用户明确追加；取得授权后用 diagnose --budget-approval '用户原话' 追加一轮，不自行批准。mark active 不绕过未完成诊断或预算授权。
- workdir 范围检测不是全机沙箱，也不替代 CLI sandbox。网页/API 必须用真实认证协议当轮回读；单测或假 CLI 不证明真实端到端通过。最终只报告实际结果与未决项。
```

`init` 的会话绑定来自当前进程真实环境，不能把另一会话 ID 当作本次 ID。没有绑定时，复制 init 实际输出的 `export CODEX_WHIP_TASK=…`，使本次根 CLI 与 hook 使用同一个绝对指针。仅在一次工具 shell 中 export 不保证后续独立 CLI 继承；应显式传入该指针，或确认本次调用的 `shell_environment_policy.set` 确已设置所需变量。不要修改全局配置来补环境。`CODEX_THREAD_ID` 不能为满足绑定而自行生成。

## 调用与验证

自然语言任务示例（在独立、可写的测试目录中交给根 AI）：

```text
使用 Codex Whip，把当前目录的 result.txt 写为 ready 加一个换行，仅允许改这个文件。
请在修改前自动登记，用 Python 只读检查文件内容；完成后报告真实验收结果。
无需规划，直接使用 Codex CLI 执行。
```

对应的登记示例由根 AI 在该工作目录执行。验收检查文件文本与预期完全相同，验收合同不能由 worker 改写：

```sh
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" init \
  --goal 'result.txt 内容为 ready 加换行' \
  --acceptance-json '["python3","-B","-c","from pathlib import Path; p=Path(\"result.txt\"); assert p.is_file() and p.read_text() == \"ready\\n\""]' \
  --allow result.txt
```

使用 init 实际输出的指针取得任务 ID；不要复制示意占位值充当真实指针。在设置了该指针的同一 shell 中：

```sh
TASK_ID=$(basename "$(dirname "$CODEX_WHIP_TASK")")
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" run --task "$TASK_ID"
python3 -I "$HOME/.codex/skills/codex-whip/scripts/whip.py" check --task "$TASK_ID"
```

`check` 运行只读验收 argv 并输出真实结果，同时将结果写入任务状态；它不会修改业务文件，不负责把暂停任务重新激活。首次验收已通过时，run 不派发 worker。诊断、暂停与预算追加的完整命令见 [Skill](../SKILL.md) 与 [运行时接口](runtime.md)。

本包单测命令：

```sh
python3 -B "$HOME/.codex/skills/codex-whip/scripts/test_whip.py"
```

单测使用临时假 CLI，不调用真实 Codex。真实 CLI 验证另行在独立测试目录执行：确认自动登记、失败时 Stop block、根 AI 读取失败证据后 diagnose 新方案并同 SID resume、完成后验收通过；另确认暂停与未登记分析放行。不要为了触发诊断修改验收合同。网页/API 任务另做当轮真实回读。

## 卸载

先由根 AI 将在途任务标为 paused 或 cancelled。备份后，从 hook 配置中只删除 Codex Whip 的 Stop command 及其对应信任条目，保留其他 hooks；从根 AGENTS 中移除本技能协议。删除安装的 `~/.codex/skills/codex-whip`，或从安装前备份人工恢复，保留之后新增的其他修改。按本机 CLI 的要求重新加载并确认 hook 已撤销。

任务状态默认位于 `~/.codex/whip`，临时产物目录以各任务 `task.json` 的 `run_dir` 为准；若设置了 `CODEX_WHIP_HOME`，使用其实际位置。卸载不会自动清除这些记录，按需要归档后再删除本技能产物。
