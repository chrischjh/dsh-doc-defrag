// dsh-doc-defrag — a skill-only DSH bundle.
//
// The whole product is the skill folder `skills/doc-defrag/` (SKILL.md +
// references/ + scripts/). This Host half only registers it with the skills
// service, so the agent can load it with the `skill` tool and run the scripts
// straight from the registered directory.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'doc-defrag'
const SKILL_DESCRIPTION =
  '把碎片化的 Markdown 文档收束成少数权威文档，其余归档（可逆、零删除）。' +
  'Use when 用户说「帮我整理/清理一下项目文档」「文档太乱了」「反碎片化」「归并文档」「文档去重」' +
  '「归档过时文档」「整理 docs 目录」「这些报告合并一下」「同一个东西写了好几份」「文档又堆起来了」；' +
  '或一次任务产出多份内容相近的 .md 之后。'

const here = dirname(fileURLToPath(import.meta.url))
const skillDir = join(here, 'skills', SKILL_NAME)

export const name = 'doc-defrag'

export function apply(ctx) {
  const skills = ctx.get('skills')
  if (skills === undefined) return

  const content = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')

  ctx.effect(
    () =>
      skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        content,
        // SkillSummary fields the registry validates; `source` must be a string.
        source: 'bundled',
        provider: 'dsh-doc-defrag',
        resourceBase: { kind: 'directory', path: skillDir },
      }),
    'doc-defrag skill',
  )
}
