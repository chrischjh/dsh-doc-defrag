---
name: doc-defrag
description: 把碎片化的 Markdown 文档收束成少数权威文档，其余归档（可逆、零删除）。Use when 用户说「帮我整理/清理一下项目文档」「文档太乱了」「反碎片化」「归并文档」「文档去重」「归档过时文档」「整理 docs 目录」「这些报告合并一下」「同一个东西写了好几份」「文档又堆起来了」；或一次任务产出多份内容相近的 .md 之后。
---

# 文档反碎片化（doc-defrag）

> 一句话让 AI 把散落的项目文档收束成几份权威文档，其余归档——**永不删除**。

## 铁律（不可被任何配置关闭；冲突时序号小者胜）

1. **不丢内容 > 一切整洁**
2. **可逆 > 彻底**
3. **高精度 > 覆盖率**（拿不准的一律 archive——可随时捞回，不必停下来问）
4. **用户当次显式指令 > 本技能默认**
5. **仓库既有约定 > 本技能推荐的结构**

八条不可违反的具体规则：

- **永不物理删除任何文件**，只允许 `archive`（`rm`、`git rm` 一律不许）
- **每次运行必须先拍 before-image 并开 journal**（`defrag run init`），动任何文件之前完成；**undo 不依赖 git**
- **清单先落盘并校验，才允许动第一个文件**；清单存不下来 → 本轮一个文件都不动
- **逐文件归属表必须落盘**（`.defrag/ledger.md`），不许只留在对话里
- **搬移必须重写文件内相对链接**，否则会造出一批断链（实测可达 47%）
- **冲突不裁决**：同一事实两处矛盾 → 写"现行口径 + 历史口径注"
- **不制造新碎片**：产出只允许进权威文档、`archive/index.md`、`.defrag/`；**禁止新建《整理报告》《SUMMARY》《CLEANUP》**
- **归档 ≠ 作废**：索引必须有「是否仍现行」一列
- **agent 文档（AGENTS.md / CLAUDE.md / skills）是可选**：只在检测到已存在时问一句，不主动建议创建

## 脚本（确定性部分，别靠模型手工数）

脚本在技能的 `scripts/defrag.mjs`，零依赖，Node ≥ 20。**先跑脚本，再让模型判断**——它比逐文件读便宜且不出幻觉。

```bash
node <skill>/scripts/defrag.mjs scan   --root <docs目录> [--repo <仓库根>] [--include-archive] [--no-clock]
node <skill>/scripts/defrag.mjs links  --root <docs目录> [--naive-links]
node <skill>/scripts/defrag.mjs ledger --root <docs目录> init|check [--out .defrag/ledger.md] [--force]
node <skill>/scripts/defrag.mjs docset --root <docs目录> verify|init|set [--file list.json] [--if-revision N]
node <skill>/scripts/defrag.mjs run    --root <docs目录> init|seal|confirm --run <runId> | list
node <skill>/scripts/defrag.mjs backup --root <docs目录> --run <runId> --path <相对路径>
node <skill>/scripts/defrag.mjs review --root <docs目录> --run <runId>
node <skill>/scripts/defrag.mjs undo   --root <docs目录> --run <runId> [--apply] [--force]
node <skill>/scripts/defrag.mjs archive --root <docs目录> --plan plan.json [--apply] [--run <runId>]
node <skill>/scripts/defrag.mjs relink  --root <docs目录> [--moves <map.json>] [--apply] [--run <runId>]
```

| 命令 | 给什么 | 什么时候用 |
|---|---|---|
| `scan` | 指纹、精确重复簇、近似重复候选（含 containment 分数与 band）、类型信号（L1 结构 / L2 文档域 / 日期比例） | 步骤 1 侦察；步骤 3 判型 |
| `links` | 断链 + 孤儿 + 入口文档，按主文档/归档分区 | 步骤 1 与步骤 6 |
| `ledger init/check` | 逐文件归属表骨架 / 校验"每个文件都有归属且 target 有效" | 步骤 3 与步骤 6 |
| `docset verify/init/set` | 清单的 schema/校验和/漂移/git 追踪检查；带锁与 `--if-revision` 前置条件的原子写 | 步骤 2 与步骤 6 |
| `archive` | 只搬家不删除，拒绝覆盖已存在目标，记录 from→to 映射 | 步骤 5 |
| `relink` | 按映射重写文件内相对链接（默认 dry-run） | 步骤 5 |
| `run` | before-image + journal：`init` 开跑、`seal` 封存指纹、`confirm` 记确认、`list` 看历史 | 步骤 0 / 7 |
| `backup` | 手工改已存在文件前备份原字节 | 步骤 5 |
| `review` | 验收卡内容（标题 + 摘要 + 去看看 + 两项选项） | 步骤 7 |
| `undo` | 一键恢复原状；不依赖 git；与 before-image 逐字节比对 | 步骤 7 / 任何时候 |

`scan` 的 `nearDuplicatePairs` 只是**候选**，`band: high` 才近乎确定重复；`low` 一律要人看。

## 严格流程（七步 · 只有两张卡 · 不许自由发挥）

> 用户说「帮我整理一下项目文档」之后，**只有两张卡**，除此之外**零提问**：
> **① 清单选择卡（首次必出，不许跳过）**：给出默认文档列表让用户选择，也给"我自己定清单"的选项；**用户的选择立即记住，下次直接用作优先清单**，不再出这张卡。
> **② 验收卡**：确认 / 恢复原状。
> **禁止**问目录、范围、分支、要不要继续；**禁止**跳步；**禁止**增加任何额外确认。
> 文档目录**固定 `docs/`**（不存在才问一句）。
> **大胆往前走**：不会物理删除、全部在 archive、随时可以 undo——谨慎不体现在提问上，体现在可后悔上。

```
1 浏览   只读扫 docs/：规模、重复簇、断链、孤儿、类型信号
2 判型   猜项目类型并摆出依据；已有 .defrag/docset.json → 跳过卡①，直接沿用
3 选清单 【卡①·首次必出】默认清单 vs 我自己定；选择立即落盘记住
4 精读   run init 拍 before-image → 分组考古精读每一份 → 归属表落盘（拿不准的一律 archive）
5 收束   按定好的清单重写权威文档（一份文档一个 subagent）
6 归档   其余过时文档 → archive（保留原路径）+ 重写链接 + 索引
7 验收   复核 → 卡②验收【确认 / 恢复原状】
```

### 步骤 1 · 浏览

```bash
node <skill>/scripts/defrag.mjs scan --root docs --repo . --include-archive --no-clock > .defrag/scan.json
node <skill>/scripts/defrag.mjs links --root docs
```

**不要逐个读文件**——精读是步骤 4 的事。

### 步骤 2 · 判型

读 `references/archetypes.md`，按 `scan.json` 的 `signals` 判：

- **L1 结构命中 ≥2** → 软件项目；有 `deploy/`、多环境、compose/Docker → `software-delivery`，否则 `software-lib`
- **L1 = 0 且 L2 某簇命中 ≥3** → 该行业
- **两簇皆强 / 皆弱** → 判「混合/不确定」，用 `generic-tasks` 派生方案，**绝不硬选**

再判**形态**：带日期文件名比例 > 30% → 人写堆积型；有 `specs/<NNN>-*/{spec,plan,tasks}.md` → agent 增殖型。

### 步骤 3 · 清单选择卡【卡① · 首次必出 · 不许跳过】

`.defrag/docset.json` 不存在时，**必须**用 `ask_user_question` 出这张卡——**不许自动开工**：

- `header`：**「文档收束方案」**
- `question`：判断结果（类型 + 置信 + 依据 ≤3 条）+ 默认清单（每份一行「名：管什么」）+「其余全部归档，永不删除」
- `options` **严格两项**：
  1. **「就用这份默认清单（推荐）」**
  2. **「我自己定清单」**

不许加第三个选项（没有"精简档"、没有"只归档"——用户真想要会说）。

| 选择 | 动作 |
|---|---|
| 就用默认 | 立即把默认清单写进 `.defrag/docset.json` → 继续步骤 4 |
| 我自己定 | 让用户贴清单（只有名字也接受，缺字段标 `scopeMissing: true`）→ **先回显覆盖分析**（每份目标的源素材量 / 无归属文件数 / 重叠）→ 写入 → 继续步骤 4 |

**用户的选择必须立即落盘**：`docset init --file list.json`（已有则 `set --if-revision <当前值>`；前置条件失败说明有人改过 → 展示 diff，**不许覆盖**）。

**下次直接用作优先清单**：`.defrag/docset.json` 存在时**不出这张卡**，开场一句话"沿用上次的 N 份"直接进入步骤 4。用户说「换一套」时才再出卡，且把记住的清单列为第一项（推荐）。

### 步骤 4 · 精读每一份文档

**第一件事**：`node <skill>/scripts/defrag.mjs run --root docs init --run <runId>`（before-image + journal）。在此之前不许写任何文件。

然后按目录组切分做**只读考古**（每组 ≤70 文件，用 `references/brief-recon.md`），产出 `文件 | 日期 | 主题 | 状态 | 归属 | 理由`：

- 大文件（>100KB）可只读标题结构，但**必须标注「仅读结构」**
- 每组回来再派下一组；subagent 失败就换名字重派，简报不变
- 汇总成 `.defrag/ledger.md`：`ledger init` 生成骨架 → 填 `state`（`merge|keep|archive|untouched`）+ `target` + `reason` → `ledger check` 必须 `coverageRatio: 1` 且无 problems
- **拿不准归属的文件 → 一律 `archive`**，reason 写「拿不准，可随时捞回」；**不要停下来问**。这类文件的数目会出现在验收卡上，用户想捞回哪个说一声就行

### 步骤 5 · 收束到定好的清单

按 `references/brief-write.md` 派写作 subagent，**一份权威文档一个 subagent**，硬约束：

- 只写它负责的那一个文件；不做 git 操作；不动别的文件
- 只写事实，全部来自现有文档；**禁止凭记忆编造**命令、端口、路径、数字
- 无法确认 → `> TODO 待核：…`
- 引用一律用**归档后的路径**
- 每步后面跟一行「判据：…」；写成"照着能复现"，不写史书
- 冲突写「现行口径 + 历史口径注」，不裁决

批次之间**不打断用户**；统一在步骤 7 的验收卡里验收。

### 步骤 6 · archive 剩余的过时文档

> 两个命令都必须带 `--run <runId>`，否则 undo 不知道搬了什么。
> **任何手工修改已存在文件的动作（写 banner、改 README）之前，先 `defrag backup --run <runId> --path <rel>`。**

1. 生成搬移计划 `plan.json`：`{ archiveRoot: "docs/archive", moves: [{from,to}, …] }`，**目录内保留原相对路径**
2. `archive --plan plan.json --run <runId>` 先 dry-run；有问题（目标已存在/越界/源缺失）逐个修
3. `--apply --run <runId>`：只搬家、不覆盖、写 `.defrag/moves/<run>.json` 与 journal
4. `relink --run <runId>`（先 dry-run 再 `--apply`）：按映射重写所有文件内的相对链接（写前自动备份）
5. 生成 `docs/archive/index.md`：`组 | 文件数 | 内容 | 为什么归档 | 已抽取进哪份 | 是否仍现行`
6. 对**已归档但链接仍失效**的文件，顶部加一行：`> 本文件已移位，相对链接可能已失效（历史文件，仅供回查）。`

### 步骤 7 · 复核 + 验收卡【卡②】

```bash
node <skill>/scripts/defrag.mjs links  --root docs       # 主文档断链必须为 0
node <skill>/scripts/defrag.mjs ledger --root docs check  # coverage 必须 1.0
node <skill>/scripts/defrag.mjs docset --root docs verify
node <skill>/scripts/defrag.mjs run   --root docs seal --run <runId>      # 封存写入后的指纹
node <skill>/scripts/defrag.mjs review --root docs --run <runId>          # 取出卡片内容
```

再按 `references/brief-verify.md` 派一个**独立复核 subagent**（只判定不改写）。`verdict: fail` 不许出卡。

**必须**用 `ask_user_question` 呈现验收卡，**不能只用一段文字总结代替**：

- `header` = card.title = **「整理完成 · 请先验收结果」**
- `question` = card.summary 每行（含「拿不准已归档 N 个，想捞回说一声」如有）+ `去看看：` + card.lookAt
- `options` 严格两项：**「确认，保留整理结果」（推荐）**、**「恢复原状」**
- 出卡之前不要问任何问题；出卡之后按选择执行，不加戏

| 选择 | 动作 |
|---|---|
| 确认 | `defrag run --root docs confirm --run <runId>` → 分组提交（新分支 `docs/defrag-YYYYMMDD`，一目录组一 commit；非 git 仓库则跳过） |
| 恢复原状 | `defrag undo --root docs --run <runId> --apply` → 报告 `mismatches`（**0 表示逐字节还原**） |

用户事后任何时候说「我后悔了」→ 直接 `undo --run <runId> --apply`。`undo` 报 `content-differs` 说明该文件在整理之后又被改过，**不许自动覆盖**，要问是否 `--force`。

交付：`.defrag/manifests/<runId>.json`（输入 sha256、逐项处置、coverage、前后断链数、校验结果）+ `docs/README.md` 维护约定段（从 docset.json 生成）。

## 稳健性：清单不丢、不互相覆盖

| 规则 | 做法 |
|---|---|
| 谁覆盖谁 | 默认列表（archetypes）只提案**永不写回**；用户级偏好只调顺序；`.defrag/docset.json` 是唯一真相；本次临时改动默认不写 |
| 写入次序 | `docset.json` 写入并校验 → 才允许 `ledger` → 才允许动正文 → 才允许 `archive` |
| 原子写 | tmp + fsync + rename + 重读校验 sha256；任何失败保留旧文件 |
| 并发 | `.defrag/.lock`（写持锁）；写必须带 `--if-revision`，不符就拒写并展示 diff |
| 历史 | 每次写入前快照到 `.defrag/history/docset-<ts>-r<N>.json`，永不自动删除 |
| 损坏 | JSON 非法/校验和不符 → **报错 + 指向历史版本，绝不静默回落默认** |
| 漂移 | `docset verify` 检查每个 `docs[].file` 是否存在；不存在就报漂移 |
| 被忽略 | 检查 `.defrag/docset.json` 是否被 gitignore；被忽略就警告并建议 `git add -f` |
| **可后悔** | 每次 run 有 before-image + journal + 逐文件原字节备份；`undo` 不依赖 git，还原后与 before-image 逐字节比对 |

## 反模式（这些是模型的默认行为，必须点明）

- ✗ 新建《整理报告.md》《SUMMARY.md》《CLEANUP.md》——整理动作本身制造新碎片
- ✗ 归档只移不修链（tianji 实测 47% 断链就是这么来的）
- ✗ 归属表只留在对话里，会话结束即蒸发
- ✗ 先搬文件后存清单
- ✗ 把 `.DS_Store` / `*.zstd` / 证据截图当文档处理（脚本默认已忽略）
- ✗ 对冲突做裁决；对"看起来重复"的两段话合成新话（文末单次提及的事实会被系统性漏掉）
- ✗ 读全文判类型；一次改完 850 文件才让人看
- ✗ 删除任何文件，或用 `git rm` 代替归档
- ✗ 问「要不要继续」「要不要精简」「这样改可以吗」——一切默认往前走，错了有验收卡和 undo 兜底

## 快路径

| 用户说 | 做什么 |
|---|---|
| 「先把过时的收起来」 | 只做判过时 + `archive` + 索引，**不写新文档、不改正文** |
| 「评估一下有多乱」 | 只跑 `scan` + `links`，零改动 |
| 「我要 A/B/C 三份」 | 停下 → 回显覆盖分析 → 按新清单重整；立即落盘记住，下次沿用 |
| 「改一下清单」 | `docset set --if-revision <revision>`，或让用户手改后 `verify` |
| 「恢复上一版清单」 | 从 `.defrag/history/` 取最近快照写回（revision +1，不改历史） |
| 「我后悔了」「恢复原状」 | `undo --run <runId> --apply`；报 `mismatches`，0 即逐字节还原 |
| ≤50 个文件 | 侦察与提案合成一条消息，一次做完 |

## 记住选择（两层）

- **项目级** `<repo>/.defrag/docset.json`（进 git）：文档清单、`perModule`（按份增长不合并的目录）、`exclude`、命名风格 → 下次直接沿用（零提问），**未来任何 agent 写文档前读到它就知道该往哪写**
- **用户级** `~/.dsh/doc-defrag/profile.json`（跨项目）：偏好档位与命名语言，**只影响推荐排序**，永不写进项目清单

## 文件

| 文件 | 用途 |
|---|---|
| `references/archetypes.md` | 六槽骨架、4 套行业默认集、未知行业四步派生、判型证据表 |
| `references/brief-recon.md` | 只读考古 subagent 简报（判定基准是核心槽位） |
| `references/brief-write.md` | 写作 subagent 简报（骨架 + 判据 + TODO + 归档路径） |
| `references/brief-verify.md` | 复核 subagent 简报（只判定不改写） |
| `scripts/defrag.mjs` | scan / links / ledger / docset / archive / relink |
| `scripts/defrag.test.mjs` | 23 条测试：并发、损坏、锁定、覆盖拒绝、断链、幂等、undo 还原、不覆盖后改 |
