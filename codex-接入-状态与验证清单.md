# Codex 子智能体接入：当前状态与验证清单

> 这份文件是给「下一个会话 / 重启后的我」看的状态快照。桌面端 DSH 重启会终结当前会话，届时按本文件继续即可。
> 最后更新：2026-10-16（当天完成根因定位 + profile 快照覆盖落盘，等待新会话复验）

## 一、任务目标

让本机的 DeepSeek Harness 能真实调用 OpenAI Codex：用户提需求 → DeepSeek 委派给 Codex → 拿回结果。实现依据是交接文档
`C:\Users\Sui\Documents\Codex\2026-10-15\new-chat\outputs\DeepSeek-Harness-调用-Codex-实现说明.md`，路线是官方组合包
`@deepseek-ai/dsh-subagent-codex`（提供方）+ `@deepseek-ai/dsh-tool-subagent`（delegation 工具行，工具名 `subagent_codex`）。

**已按用户要求改走用户自己的中转站**（`https://api.lolicon.beer`，Codex 原生 `~/.codex/config.toml` 里配置），不订阅 OpenAI 官方。

## 二、已核实的事实（代码级 / 实测，非猜测）

| 项 | 值 | 依据 |
|---|---|---|
| 桌面端 App 版本 | `0.2.0-rc.2`（FileVersion） | `DeepSeek Harness.exe` 版本资源 |
| 当前会话所在 profile | `desktop` | 进程命令行 `...dsh-desktop-host\lib\index.js ... C:\Users\Sui\.dsh\profiles\desktop` |
| 组合包 | 已装 `@deepseek-ai/dsh-subagent-codex@0.2.0-rc.2`（2026-10-15 23:05:01） | `profiles\desktop\package.json`（dependencies + `dsh.profile.bundles` 末位）；插件管理器日志 `operation-IkWNKp` |
| 自带 Codex 载荷 | `@openai/codex@0.153.4`（含 `codex-win32-x64` 原生 `codex.exe` 281.7 MB） | `profiles\desktop\node_modules\@openai\codex*`；`node bin/codex.js --version` → `codex-cli 0.153.4` |
| 公共 CLI 能否代装 | **不能**，`desktop` 被硬拒绝 | `error: profile "desktop" is managed exclusively by the Electron application`（连 `--dump-config` 也一样） |
| 社区市场能否装 | 不能，307 条目录里官方包数量为 0 | `.dsh-market\discovery-compatibility-v1.json` |
| 不需要官方登录 | 中转站已在 Codex 原生配置里，`requires_openai_auth = false` + 原生 bearer token；`codex login status` 显示 `Not logged in` 与本链路无关 | `C:\Users\Sui\.codex\config.toml`（`model_provider = "custom"`、`model = "gpt-6-astra"`） |
| 中转站链路（Codex exec 层） | **实测通过**：`codex exec` 在 `G:\multimodal-canvas` 返回 `PONG-7421` / `17*19=323`，exit 0 | 头部显示 `provider custom`、`approval never`、`sandbox danger-full-access`、`reasoning effort ultra` |
| 中转站链路（DSH 提供方协议层） | **实测通过**：自写 app-server 探针跑通 `initialize → thread/start(ephemeral) → turn/start → turn/completed`，拿到 `phase:"final_answer"` = `MARKER-QX7-4E91` + `17*19=323` | `G:\multimodal-canvas\codex-wire-probe.mjs`（协议照抄 `packages\subagent\subagent-codex\src\wire.ts`） |
| 实际生效的 Codex 权限 | `approval: never` + `sandbox: danger-full-access`（**默认 `permissionMode: never` 并不等于只读**，实际由 Codex 原生 `sandbox_mode` 决定） | 上述两次实测头部输出 |
| 工具行为何一直不生效 | **根因**：该行嵌在 `preset-standard.config.plugins` 的 `delegation` 组里，而 profile patch 只能按 id 命中「被 `applyEntryPatches` 索引的条目」——它只递归 `group: true && Array.isArray(config)` 的兄弟行，不进入 `config.plugins` 这个对象字段 | `G:\deepseek-harness\apps\cli\node_modules\@deepseek-ai\cordis-plugin-include\src\index.ts` 的 `buildMap`；实测日志 `patch: entry %C not found tool-subagent-codex` |
| 正确解法 | **profile 级 `preset-standard` 全量快照覆盖**（整段 config 替换，删掉 codex 行的 `disabled: true`） | 与 `billion-context` 的 `dsh.bundle.patch.yml` 注释一致：「this bundle layer cannot address by id … needs a profile-level full-snapshot override of preset-standard」 |
| 覆盖是否已落盘 | **是**（2026-10-16，`cordis.patch.yml` 现 251 行 / 28 条目，末项 = `preset-standard`） | 生成器 `G:\multimodal-canvas\codex-preset-enable.mjs`；落盘前干跑 + 落盘后复算均 0 warning |

## 三、本轮实际做了什么

1. **定位根因**（H1 成立）：先按旧方案在 `cordis.patch.yml` 末尾追加的 `- id: tool-subagent-codex / disabled: false` 是**无效项**——加载器日志明确报
   `patch: entry %C not found tool-subagent-codex`。已由覆盖快照取代（脚本 `--write` 会连带删掉这条无效项）。
2. **写生成器** `G:\multimodal-canvas\codex-preset-enable.mjs`：合成 desktop profile 的全部 bundle patch 层（12 层）→ 与随包 shipped
   `presets\standard.patch.yml` 比对（结论：**完全一致**，没有别的层动过它）→ 生成「整段 config」快照文本（仅删 codex 行的 `disabled: true`，空行/块标量原样保留）→
   干跑 `applyEntryPatches` 校验（0 warning、行数 19→19、除该标志外整份 config 深度相等）→ `--write` 落盘（先备份、落盘前检查文件未被运行中的 App 改写）。
3. **落盘结果**：备份 `C:\Users\Sui\.dsh\profiles\desktop\cordis.patch.yml.bak-1792082785452`；
   落盘后复算：`warnings=0 rows=19 tool-subagent-codex.disabled=undefined`（即已启用）。
4. **清理**：删除了实验用的临时 profile `C:\Users\Sui\.dsh\profiles\dsh-sbx`（先删 junction 再删目录，desktop 的 `node_modules` 59 项前后一致、未受影响）。

## 四、下一步（未完成的部分）

- [ ] **在桌面端新开一个会话**，确认工具列表里出现 `subagent_codex`（预设声明的改动只影响之后创建的会话）。
      - 若新会话仍没有：**重启桌面端**（App 重启才会重新读 profile 组合），再新开会话确认。
- [ ] 出现后跑验收清单（第五节）。注意：§7 的「随机标记 + `17*19=323`」目前只在 **Codex 层**通过（exec + app-server 探针），
      还没经过 DSH 工具层，必须在会话里让 `subagent_codex` 真跑一次才算通过。
- [ ] 认证相关：**无需** OpenAI 登录；但若将来要换回官方订阅，才需要 `codex login`。

## 五、验收清单（交接文档 §7）

前置：`subagent_codex` 出现在新会话工具列表里，且**没有重复行**。

1. 记录版本：DSH / 组合包 / Codex 载荷。
2. 无文件冒烟：让 Codex 生成一个随机标记并计算 `17 × 19`，回答必须是 `323` 且标记与要求一致。
3. 目录读取：在工作目录里建一个随机文本文件，要求 Codex 读出其中内容。
4. Windows 路径：工作目录带空格与中文（例如 `G:\multimodal-canvas\临时 目录`）仍能执行。
5. 失败路径：给一个不存在的 cwd，必须报错而不是伪装成功。
6. 取消：发起后取消，必须落到终态并释放进程。
7. 二次委派：再发一次任务，结果独立、不串味。
8. 关闭组合包后，工具应从工具列表中消失。

## 六、权限配置（现状与语义）

`subagent-codex` 提供方行配置项：`providerName`（默认 `codex`）、`model`、`env`、`permissionMode`（默认 `never`）、`disposeGraceMs`（默认 3000）。
`permissionMode` 三档：`never`（`approvalPolicy: never`，**不发送 sandbox 字段**）、`approve-for-me`（on-request + `auto_review` + `workspace-write`）、
`dangerously-bypass-approvals-and-sandbox`（never + `danger-full-access`）。

⚠️ 本机实测：`never` 档下生效的 sandbox 来自 Codex 原生 `config.toml` 的 `sandbox_mode = "danger-full-access"`，因此**当前委派给 Codex 的进程可自由读写文件**。
这是本机 Codex 配置决定的，不是 DSH 放宽的；若要收紧，改 `C:\Users\Sui\.codex\config.toml` 的 `sandbox_mode`（例如 `workspace-write`），而不是在 DSH 侧假装只读。

## 七、回滚

1. 还原 profile patch：`Copy-Item "C:\Users\Sui\.dsh\profiles\desktop\cordis.patch.yml.bak-1792082785452" "C:\Users\Sui\.dsh\profiles\desktop\cordis.patch.yml" -Force`
   （该备份 = 覆盖落盘前、但已含那条无效 `tool-subagent-codex` 项；如需更早状态用 `.bak-1792077883171` / `.bak-1791335253071`）。
2. 卸载组合包：在桌面端「插件」页卸载 `@deepseek-ai/dsh-subagent-codex`（等价于从 `package.json` 的 dependencies 与 `dsh.profile.bundles` 移除后重装依赖）。
3. 重启桌面端使组合生效。

## 八、关键路径速查

- profile：`C:\Users\Sui\.dsh\profiles\desktop\`（`package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml`）
- 启用脚本：`G:\multimodal-canvas\codex-preset-enable.mjs`（`node …` = 干跑；`node … --write` = 落盘并备份）
- 协议探针：`G:\multimodal-canvas\codex-wire-probe.mjs`（自写 app-server JSON-RPC 探针，不经 DSH 工具层）
- 官方源码检出：`G:\deepseek-harness\`（`packages\subagent\subagent-codex\`、`apps\cli\node_modules\@deepseek-ai\cordis-plugin-include\src\index.ts`）
- 随包 preset：`G:\deepseek-harness\packages\bundle\web-app\presets\standard.patch.yml`（工具行在该文件 103-110 行，`disabled: true`）
- 组合包文档：`G:\deepseek-harness\packages\subagent\subagent-codex\README.zh.md`；预设文档：`packages\preset\agent-preset\README.zh.md`
- Codex 原生配置：`C:\Users\Sui\.codex\config.toml`（含明文 bearer token —— 不要整份复制进对话）
