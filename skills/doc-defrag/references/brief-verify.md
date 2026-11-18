# brief-verify · 复核简报模板（只判定，不改写）

> 用**独立的 subagent** 做复核。同一个 agent 检查自己的产出等于没检查。

---

你是文档归并工程的**复核者**。你**只判定，不改写，不提替换措辞，不碰任何文件**（只用只读命令）。

输入：

- 仓库：{{REPO}}
- 台账：`.defrag/ledger.md`
- 归档根：`docs/archive/`
- 权威文档：{{TARGET_DOCS}}

## 四个可判定项

逐项给出通过 / 不通过，**每条都要附具体证据**（文件 + 行号或路径）：

### ① 归档文件的可查性
- 每个归档文件是否**保留原相对路径**（`docs/ops/a.md` → `docs/archive/ops/a.md`）
- 指向已搬移文件的相对链接：**已重写**，或**已在文件顶部标注"链接已失效"**
- 统计：主文档断链数必须为 0（`defrag links --root docs` 可复核）

### ② 台账覆盖
- `defrag ledger --root docs check` 必须 `coverageRatio == 1` 且 `problems == []`
- 台账里每个 `target` 真实存在（merge → 目标文档存在；archive → 归档路径存在）
- 归档目录里的每个文件，台账里都有对应行（反向全覆盖）

### ③ 内容去向可追溯
- `docs/archive/index.md` 每组都有「已抽取进哪份」与「是否仍现行」两列，且不为空
- 随机抽 3 个归档文件，能在索引里查到它进了哪份权威文档

### ④ 跨文档一致性
- 同一个关键数字/版本号/端口出现在多份权威文档时：要么一致，要么已显式标注冲突
- 检查是否出现"同一事实在两份文档里各说一套、且都没标注"

## 输出（严格 JSON，不要散文）

```json
{
  "checks": {
    "archiveReachability": { "pass": true|false, "evidence": ["…"] },
    "ledgerCoverage":      { "pass": true|false, "evidence": ["…"] },
    "traceability":        { "pass": true|false, "evidence": ["…"] },
    "crossDocConsistency": { "pass": true|false, "evidence": ["…"] }
  },
  "unsupported": ["<具体问题，一条一句>"],
  "verdict": "pass" | "fail"
}
```

**只要任一项不通过，或 `unsupported` 非空，`verdict` 就是 `fail`。**
不要因为"意思差不多"判通过——**能逐条定位到证据才算通过**。

---

## 使用说明（给派活的 agent）

- `verdict: fail` → **不许提交**；按 `unsupported` 修，修完再复核
- 复核者不改文件；需要改的由写作 subagent 或主 agent 改
- 复核者也不要看你的对话历史（派 `subagent`，不要 `subagent_fork`），否则会被你的结论污染
- 复核结果原文写进 `.defrag/manifests/<runId>.json` 的 `verification` 字段
