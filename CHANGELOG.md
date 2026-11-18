# CHANGELOG

## 0.2.2 — 2026-11-18

- README 去掉指向 DESIGN.md 的链接（设计文档不随包发布）
## 0.2.1 — 2026-11-18

- README 默认英文（`README.md`），中文移至 `README.zh-CN.md`，顶部互相切换
- npm 包内同时携带双语 README
## 0.2.0 — 2026-11-17

**可后悔（不依赖 git）**

- `run init`：动第一笔之前拍 before-image（全部文件相对路径 + 原始字节 sha256）
- `journal`：追加式记录 `move{from,to}` / `edit{path,backup,beforeSha,afterSha}`，`status: open→sealed→confirmed/restored`
- `backup`：手工改任何已存在文件之前先备份原字节
- `run seal`：封存本次写入后的指纹，供 undo 判断"整理之后是否又被人改过"
- `undo`：还原编辑 → 搬回归档 → 移走新建文档到 `.defrag/runs/<id>/created/` → 清理本次创建的空目录 → **与 before-image 逐字节比对**
- `review`：产出验收卡内容（大标题 + summary + lookAt + 两项 `confirm`/`restore`）
- 打开文件时的保护：`afterSha` 不符（整理后又被改过）→ 跳过并报告，必须 `--force` 才覆盖
- `deleted` 恒为 0

**傻瓜式流程（严格七步 · 全程零提问 · 不许自由发挥）**

- **只有两张卡**：①文档收束方案（首次必出：默认清单 / 我自己定；选择立即落盘记住，下次直接用作优先清单不再出卡）②验收卡（确认 / 恢复原状）；除此之外零提问
- 删除了"定范围三问"、"清单选择卡"、"第一批验收"中途打断；文档目录固定 `docs/`
- 拿不准归属的文件一律 archive（reason 标「拿不准，可随时捞回」），数量在验收卡上报告——不因谨慎而提问
- 自定义清单变成随时可说的话术（「我要 A/B/C」），停下回显覆盖分析后按新清单重整
- 验收卡写死选项集合与呈现方式（ask_user_question）；出卡前禁止任何提问

**验证**

- 23 条测试全绿（新增 5 条：before-image、undo 还原、不覆盖后改、验收卡、状态流转）
- 真实语料（tianji 295 文件 / 5.0MB）：搬移 60 + 改链 3 → undo 后 `diff -r` 与原副本**逐字节一致**，`mismatches: 0`

## 0.1.0 — 2026-11-17

首个版本：事后补救（归并 + 归档），零物理删除。

**技能**

- `SKILL.md`：七步流程 + 三道门、五级优先级、八条铁律、反模式、快路径、两层记忆（项目清单 + 用户偏好）
- `references/archetypes.md`：六槽骨架、九套行业默认集、未知行业四步派生、精简档裁剪规则
- `references/brief-recon.md`：只读考古简报（核心槽位=判定基准）
- `references/brief-write.md`：写作简报（骨架 + 每步判据 + `TODO 待核` + 归档路径）
- `references/brief-verify.md`：独立复核简报（只判定不改写）

**脚本** `scripts/defrag.mjs`（零依赖，Node ≥ 20）

- `scan`：指纹（sha256 + SimHash）、精确重复、近似重复候选（SimHash 过滤 + 5-gram containment 精确化，带 high/medium/low 分档）、类型信号（L1 结构 / L2 文档域 / 日期比例）
- `links`：断链 + 孤儿 + 入口文档，按主文档/归档分区；`--naive-links` 复现历史基线
- `ledger`：逐文件归属表骨架 / 覆盖率校验（`coverageRatio` 必须为 1）
- `docset`：清单的 `verify / init / set`；原子写 + 自证 sha256 + `.lock` + `--if-revision` 前置条件 + 写入前历史快照
- `archive`：只搬家不删除；拒绝覆盖、拒绝越界、拒绝已归档源；记录 `from→to` 映射
- `relink`：按映射重写相对链接（默认 dry-run）

**验证**

- 18 条测试全绿：并发/锁定、损坏 JSON 不回落默认、手改后校验和报错、前置条件拒绝、无残留临时文件、归档不覆盖、relink dry-run、scan 幂等
- 真实语料回归（tianji-dashboard/docs，320 个 md / 5.8MB）：扫描 5.5 秒；`links --naive-links` 精确复现 208 断链基线；主文档 53 链接 0 断
