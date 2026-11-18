#!/usr/bin/env node
/**
 * defrag.mjs robustness tests (node --test).
 *
 * The eight cases in DESIGN.md §9.8 plus the parsing/link/ledger behaviour they rely on.
 * Every test runs in its own temp directory; nothing touches a real repository.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { parseMd, simhash64, hamming, resolveLink, validateDocset, parseLedger, docsetSha } from './defrag.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'defrag.mjs')

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'defrag-test-'))
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

function write(dir, rel, text) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts })
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', json: safeJson(r.stdout) }
}
const safeJson = (s) => { try { return JSON.parse(s) } catch { return null } }

// ─────────────────────────── parsing / linkage ────────────────────────────

test('parseMd: headings, title, links, skips fences and HTML comments', () => {
  const md = [
    '# 标题', '',
    '见 [文档](./other.md) 与 `src/app.py`。', '',
    '```', '[不该算](./nope.md)', '```', '',
    '<!-- [也不算](./nope2.md) -->', '',
    '## 小节', '![图](./pic.png)',
  ].join('\n')
  const p = parseMd(md)
  assert.equal(p.title, '标题')
  assert.equal(p.headings.length, 2)
  const hrefs = p.links.map((l) => l.href)
  assert.deepEqual(hrefs, ['./other.md', './pic.png'], 'fenced + commented links must be excluded')
  assert.equal(p.refs.length, 1)
})

test('resolveLink: infers .md and README by default, strict in naive mode', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'a.md', '# a')
    write(dir, 'b.md', '# b')
    write(dir, 'sub/README.md', '# r')
    assert.equal(resolveLink(dir, 'a.md', './b').kind, 'file')
    assert.equal(resolveLink(dir, 'a.md', './b', { naive: true }).kind, 'missing')
    assert.equal(resolveLink(dir, 'a.md', './sub').kind, 'file')
    // a directory that exists counts as resolved even in naive mode (existsSync semantics)
    assert.equal(resolveLink(dir, 'a.md', './sub/', { naive: true }).kind, 'file')
    assert.equal(resolveLink(dir, 'a.md', 'https://x.y').kind, 'external')
    assert.equal(resolveLink(dir, 'a.md', 'file:///d:/x.py', { naive: true }).kind, 'missing')
  } finally { cleanup() }
})

test('simhash64: near-identical text is close, unrelated text is far', () => {
  const a = '船岸同步采用增量推送，令牌由岸基下发，船端每两分钟拉取一次。'
  const b = '船岸同步采用增量推送，令牌由岸基下发，船端每两分钟拉取一次。'
  const c = '今天天气不错，适合出门散步，顺便买点水果。'
  const dA = hamming(simhash64(a), simhash64(b))
  const dC = hamming(simhash64(a), simhash64(c))
  assert.equal(dA, 0)
  assert.ok(dC > 6, `unrelated distance ${dC} should exceed threshold`)
})

// ─────────────────────────── scan ───────────────────────────

test('scan: detects exact and near duplicates, is byte-identical across runs', () => {
  const { dir, cleanup } = tmp()
  try {
    const body = '# 部署\n\n固定步骤：初始化 → 打包 → 安装 → 验收。\n'
    write(dir, 'docs/a.md', body)
    write(dir, 'docs/a-copy.md', body)
    write(dir, 'docs/b.md', '# 部署\n\n固定步骤：初始化 → 打包 → 安装 → 验收。\n\n补充一句说明。\n')
    write(dir, 'docs/unrelated.md', '# 会议室预订\n\n流程与部署完全无关。\n')

    const r1 = spawnSync(process.execPath, [CLI, 'scan', '--root', join(dir, 'docs'), '--no-clock'], { encoding: 'utf8' })
    const r2 = spawnSync(process.execPath, [CLI, 'scan', '--root', join(dir, 'docs'), '--no-clock'], { encoding: 'utf8' })
    assert.equal(r1.stdout, r2.stdout, 'two runs must be byte-identical')

    const s = JSON.parse(r1.stdout)
    assert.equal(s.counts.mdFiles, 4)
    assert.equal(s.exactDuplicates.length, 1)
    assert.ok(s.nearDuplicatePairs.some((p) => p.a === 'a.md' && p.b === 'b.md' || p.b === 'a.md' && p.a === 'b.md'))
    assert.ok(!s.nearDuplicatePairs.some((p) => p.b === 'unrelated.md'))
  } finally { cleanup() }
})

// ─────────────────────────── ledger ───────────────────────────

test('ledger: init writes a skeleton covering every md, check fails on TODO', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a')
    write(dir, 'docs/b.md', '# b')
    const init = run(['ledger', '--root', join(dir, 'docs'), 'mode=init'.startsWith('m') ? '--mode' : '--mode', 'init'])
    assert.equal(init.code, 0)
    const ledger = readFileSync(join(dir, 'docs/.defrag/ledger.md'), 'utf8')
    assert.match(ledger, /a\.md \| TODO/)
    assert.match(ledger, /b\.md \| TODO/)

    const check = run(['ledger', '--root', join(dir, 'docs'), '--check'])
    assert.equal(check.code, 1, 'TODO rows must fail the gate')
    assert.equal(check.json.coverageRatio, 0)
    assert.equal(check.json.problems.length, 2)
  } finally { cleanup() }
})

test('ledger: check passes only when every file has a valid disposition and target', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a')
    write(dir, 'docs/b.md', '# b')
    write(dir, 'docs/archive/old.md', '# old')
    const ledger = [
      '| # | file | state | target | reason |',
      '|---|---|---|---|---|',
      '| 1 | a.md | keep | — | 权威文档 |',
      '| 2 | b.md | merge | a.md | 内容并入 a |',
      '| 3 | archive/old.md | archive | archive/old.md | 过时 |',
    ].join('\n')
    write(dir, 'docs/.defrag/ledger.md', ledger)

    const check = run(['ledger', '--root', join(dir, 'docs'), '--check'])
    assert.equal(check.code, 0)
    assert.equal(check.json.coverageRatio, 1)
    assert.deepEqual(check.json.problems, [])

    // a file with no row must be caught
    write(dir, 'docs/c.md', '# c')
    const again = run(['ledger', '--root', join(dir, 'docs'), '--check'])
    assert.equal(again.code, 1)
    assert.equal(again.json.problems[0].problem, 'missing-row')
  } finally { cleanup() }
})

test('parseLedger tolerates 4-column and 5-column tables', () => {
  const five = parseLedger('| # | file | state | target | reason |\n|---|---|---|---|---|\n| 1 | a.md | keep | — | x |')
  const four = parseLedger('| file | state | target | reason |\n|---|---|---|---|\n| a.md | keep | — | x |')
  assert.equal(five.length, 1)
  assert.equal(four.length, 1)
  assert.equal(five[0].file, 'a.md')
  assert.equal(four[0].file, 'a.md')
  assert.equal(four[0].state, 'keep')
})

// ─────────────────────────── docset ───────────────────────────

const validDocset = {
  version: 1,
  archetype: 'software-delivery',
  confirmedAt: '2026-11-17',
  docs: [
    { file: 'docs/01-系统设计.md', name: '系统设计', scope: '架构/数据流', excludes: '部署' },
    { file: 'docs/02-环境部署.md', name: '环境部署', scope: '环境', excludes: '业务' },
  ],
}

test('docset init: writes revision 1, read-back checks, no history yet', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/01-系统设计.md', '# 1')
    write(dir, 'docs/02-环境部署.md', '# 2')
    write(dir, 'list.json', JSON.stringify(validDocset))
    const r = run(['docset', '--root', dir, 'init', '--file', 'list.json'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.json.revision, 1)
    assert.equal(r.json.history, null)

    const saved = JSON.parse(readFileSync(join(dir, '.defrag/docset.json'), 'utf8'))
    assert.equal(saved.revision, 1)
    assert.equal(docsetSha(saved), saved.sha256, 'checksum must match canonical json')

    const v = run(['docset', '--root', dir, 'verify'])
    assert.equal(v.code, 0)
    assert.equal(v.json.revision, 1)
  } finally { cleanup() }
})

test('docset init refuses to overwrite an existing confirmed list', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/01-系统设计.md', '# 1')
    write(dir, 'docs/02-环境部署.md', '# 2')
    write(dir, 'list.json', JSON.stringify(validDocset))
    assert.equal(run(['docset', '--root', dir, 'init', '--file', 'list.json']).code, 0)
    const again = run(['docset', '--root', dir, 'init', '--file', 'list.json'])
    assert.equal(again.code, 2)
    assert.match(again.err, /already exists/)
  } finally { cleanup() }
})

test('docset set: requires --if-revision and refuses on mismatch, leaving the file untouched', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/01-系统设计.md', '# 1')
    write(dir, 'docs/02-环境部署.md', '# 2')
    write(dir, 'list.json', JSON.stringify(validDocset))
    run(['docset', '--root', dir, 'init', '--file', 'list.json'])

    const before = readFileSync(join(dir, '.defrag/docset.json'), 'utf8')

    const noPre = run(['docset', '--root', dir, 'set', '--file', 'list.json'])
    assert.equal(noPre.code, 2)
    assert.match(noPre.err, /--if-revision/)

    const wrong = run(['docset', '--root', dir, 'set', '--file', 'list.json', '--if-revision', '9'])
    assert.equal(wrong.code, 2)
    assert.match(wrong.err, /precondition failed/)
    assert.equal(readFileSync(join(dir, '.defrag/docset.json'), 'utf8'), before, 'failed precondition must not write')

    const ok = run(['docset', '--root', dir, 'set', '--file', 'list.json', '--if-revision', '1'])
    assert.equal(ok.code, 0, ok.err)
    assert.equal(ok.json.revision, 2)
    assert.ok(ok.json.history, 'previous version must be snapshotted')
    const histFiles = readdirSync(join(dir, '.defrag/history'))
    assert.equal(histFiles.length, 1)
    assert.match(histFiles[0], /-r1\.json$/)
  } finally { cleanup() }
})

test('docset: a running lock blocks writes (no silent clobber)', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/01-系统设计.md', '# 1')
    write(dir, 'docs/02-环境部署.md', '# 2')
    write(dir, 'list.json', JSON.stringify(validDocset))
    write(dir, '.defrag/.lock', JSON.stringify({ pid: 999999, host: 'other', startedAt: Date.now() }))
    const r = run(['docset', '--root', dir, 'init', '--file', 'list.json'])
    assert.equal(r.code, 2)
    assert.match(r.err, /holds the lock/)
  } finally { cleanup() }
})

test('docset: corrupted JSON fails loudly and never falls back to defaults', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, '.defrag/docset.json', '{"version":1,"docs":[{"file":')
    const v = run(['docset', '--root', dir, 'verify'])
    assert.equal(v.code, 1)
    const problem = v.json.problems[0]
    assert.equal(problem.problem, 'load')
    assert.match(problem.detail, /not valid JSON|refusing to fall back/)
  } finally { cleanup() }
})

test('docset: checksum mismatch after hand-editing is reported, not silently accepted', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/01-系统设计.md', '# 1')
    write(dir, 'docs/02-环境部署.md', '# 2')
    write(dir, 'list.json', JSON.stringify(validDocset))
    run(['docset', '--root', dir, 'init', '--file', 'list.json'])

    const p = join(dir, '.defrag/docset.json')
    const saved = JSON.parse(readFileSync(p, 'utf8'))
    saved.docs.push({ file: 'docs/03-待办.md', name: '待办', scope: '未完成' })
    writeFileSync(p, JSON.stringify(saved, null, 2) + '\n')

    const v = run(['docset', '--root', dir, 'verify'])
    assert.equal(v.code, 1)
    assert.match(v.json.problems[0].detail, /checksum mismatch/)
  } finally { cleanup() }
})

test('validateDocset: tolerates scopeMissing, rejects duplicates and empty lists', () => {
  assert.deepEqual(validateDocset({ revision: 1, docs: [{ file: 'a.md', name: 'A', scopeMissing: true }] }), [])
  assert.match(validateDocset({ revision: 1, docs: [{ file: 'a.md', name: 'A' }] }).join(' '), /scope/)
  assert.match(validateDocset({ revision: 1, docs: [{ file: 'a.md', name: 'A', scope: 'x' }, { file: 'a.md', name: 'B', scope: 'y' }] }).join(' '), /duplicate/)
  assert.match(validateDocset({ revision: 1, docs: [] }).join(' '), /non-empty/)
})

test('docset: no leftover temp files after any write attempt', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/01-系统设计.md', '# 1')
    write(dir, 'docs/02-环境部署.md', '# 2')
    write(dir, 'list.json', JSON.stringify(validDocset))
    run(['docset', '--root', dir, 'init', '--file', 'list.json'])
    const leftovers = readdirSync(join(dir, '.defrag')).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  } finally { cleanup() }
})

// ─────────────────────────── relink ───────────────────────────

test('archive: moves without deleting, refuses overwrite, records the map', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/ops/a.md', '# a')
    write(dir, 'docs/ops/b.md', '# b')
    write(dir, 'docs/archive/keep.md', '# k')
    const plan = {
      archiveRoot: 'docs/archive',
      moves: [
        { from: 'docs/ops/a.md', to: 'docs/archive/ops/a.md' },
        { from: 'docs/ops/b.md', to: 'docs/archive/ops/b.md' },
      ],
    }
    write(dir, 'plan.json', JSON.stringify(plan))

    const dry = run(['archive', '--root', dir, '--plan', 'plan.json'])
    assert.equal(dry.code, 0)
    assert.equal(dry.json.apply, false)
    assert.equal(dry.json.counts.moves, 2)

    const applied = run(['archive', '--root', dir, '--plan', 'plan.json', '--apply'])
    assert.equal(applied.code, 0, applied.err)
    assert.equal(applied.json.deleted, 0)
    assert.equal(applied.json.counts.verified, 2)
    assert.ok(existsSync(join(dir, 'docs/archive/ops/a.md')))
    assert.ok(!existsSync(join(dir, 'docs/ops/a.md')), 'source path is gone (moved, not copied)')
    assert.ok(existsSync(join(dir, applied.json.movesFile)), 'move map must be recorded')

    // target already exists → refuse
    write(dir, 'plan2.json', JSON.stringify({ archiveRoot: 'docs/archive', moves: [{ from: 'docs/archive/keep.md', to: 'docs/archive/ops/a.md' }] }))
    const refuse = run(['archive', '--root', dir, '--plan', 'plan2.json'])
    assert.equal(refuse.code, 1, 'a refused plan must exit non-zero')
    assert.equal(refuse.json.ok, false)
    assert.equal(refuse.json.problems[0].problem, 'target-exists')
  } finally { cleanup() }
})

test('relink: repairs links whose target moved, dry-run then apply', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a\n\n见 [手册](manuals/ops.md)。\n')
    write(dir, 'docs/manuals/ops.md', '# ops')
    write(dir, 'plan.json', JSON.stringify({
      archiveRoot: 'docs/archive',
      moves: [{ from: 'docs/manuals/ops.md', to: 'docs/archive/manuals/ops.md' }],
    }))
    assert.equal(run(['archive', '--root', dir, '--plan', 'plan.json', '--apply']).code, 0)

    const dry = run(['relink', '--root', dir])
    assert.equal(dry.code, 0)
    assert.equal(dry.json.apply, false)
    assert.equal(dry.json.count, 1)
    assert.equal(readFileSync(join(dir, 'docs/a.md'), 'utf8'), '# a\n\n见 [手册](manuals/ops.md)。\n', 'dry-run must not write')

    const applied = run(['relink', '--root', dir, '--apply'])
    assert.equal(applied.code, 0)
    const fixed = readFileSync(join(dir, 'docs/a.md'), 'utf8')
    assert.match(fixed, /\[手册\]\(\.\/archive\/manuals\/ops\.md\)/)
    assert.equal(resolveLink(join(dir, 'docs'), 'a.md', './archive/manuals/ops.md').kind, 'file')
  } finally { cleanup() }
})

// ─────────────────────── run journal + undo (no git) ───────────────────────

test('run init: captures a full before-image without git', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a\n')
    write(dir, 'docs/ops/b.md', '# b\n')
    write(dir, 'docs/pic.png', 'not really a png')
    const r = run(['run', '--root', join(dir, 'docs'), 'init', '--run', 'r1'])
    assert.equal(r.code, 0, r.err)
    const before = JSON.parse(readFileSync(join(dir, 'docs/.defrag/runs/r1/before.json'), 'utf8'))
    assert.equal(before.files.length, 2, 'binary/ignored files are excluded')
    assert.deepEqual(before.files.map((f) => f.path).sort(), ['a.md', 'ops/b.md'])
    const j = JSON.parse(readFileSync(join(dir, 'docs/.defrag/runs/r1/journal.json'), 'utf8'))
    assert.equal(j.status, 'open')
  } finally { cleanup() }
})

test('undo: restores archived files and original bytes, never deletes', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a\n\n见 [手册](manuals/ops.md)。\n')
    write(dir, 'docs/manuals/ops.md', '# ops\n')
    const root = join(dir, 'docs')
    assert.equal(run(['run', '--root', root, 'init', '--run', 'r1']).code, 0)

    write(root, 'plan.json', JSON.stringify({
      archiveRoot: 'archive',
      moves: [{ from: 'manuals/ops.md', to: 'archive/manuals/ops.md' }],
    }))
    assert.equal(run(['archive', '--root', root, '--plan', 'plan.json', '--apply', '--run', 'r1']).code, 0)
    assert.equal(run(['relink', '--root', root, '--apply', '--run', 'r1']).code, 0)
    // a new authoritative doc appears (created, not edited)
    write(root, '01-系统设计.md', '# 系统设计\n')
    assert.equal(run(['run', '--root', root, 'seal', '--run', 'r1']).code, 0)

    assert.match(readFileSync(join(root, 'a.md'), 'utf8'), /archive\/manuals\/ops\.md/, 'link was rewritten')
    assert.ok(existsSync(join(root, 'archive/manuals/ops.md')))

    const dry = run(['undo', '--root', root, '--run', 'r1'])
    assert.equal(dry.code, 0)
    assert.equal(dry.json.apply, false)
    assert.equal(dry.json.counts.movesBack, 1)
    assert.equal(dry.json.counts.editsBack, 1)
    assert.equal(dry.json.counts.createdAside, 1)
    assert.ok(existsSync(join(root, 'archive/manuals/ops.md')), 'dry-run must not move anything')
    assert.ok(existsSync(join(root, '01-系统设计.md')))

    const applied = run(['undo', '--root', root, '--run', 'r1', '--apply'])
    assert.equal(applied.code, 0, applied.err)
    assert.equal(applied.json.deleted, 0)
    assert.equal(applied.json.counts.mismatches, 0, 'tree must match the before-image exactly')

    assert.ok(existsSync(join(root, 'manuals/ops.md')), 'archived file is back at its original path')
    assert.ok(!existsSync(join(root, 'archive/manuals/ops.md')))
    assert.equal(readFileSync(join(root, 'a.md'), 'utf8'), '# a\n\n见 [手册](manuals/ops.md)。\n', 'original bytes restored')

    const side = join(root, applied.json.createdAsideDir)
    const setAside = readdirSync(side)
    assert.equal(setAside.length, 1)
    assert.match(readFileSync(join(side, setAside[0]), 'utf8'), /系统设计/, 'created file is set aside, never deleted')
    assert.ok(!existsSync(join(root, '01-系统设计.md')))
  } finally { cleanup() }
})

test('undo: never clobbers an edit made after the run ran', () => {
  const { dir, cleanup } = tmp()
  try {
    const root = join(dir, 'docs')
    write(root, 'a.md', '# original\n')
    assert.equal(run(['run', '--root', root, 'init', '--run', 'r2']).code, 0)
    assert.equal(run(['backup', '--root', root, '--run', 'r2', '--path', 'a.md']).code, 0)
    writeFileSync(join(root, 'a.md'), '# our edit\n')      // the run's own edit
    assert.equal(run(['run', '--root', root, 'seal', '--run', 'r2']).code, 0)
    writeFileSync(join(root, 'a.md'), '# user edit later\n') // the user keeps working

    const applied = run(['undo', '--root', root, '--run', 'r2', '--apply'])
    assert.ok(applied.json.counts.mismatches >= 1, 'a changed-after-run file must be reported')
    assert.match(applied.json.mismatches[0].problem, /content-differs|still-missing/)
    assert.match(readFileSync(join(root, 'a.md'), 'utf8'), /user edit later/, 'the later hand edit is preserved')

    const forced = run(['undo', '--root', root, '--run', 'r2', '--apply', '--force'])
    assert.equal(forced.json.counts.mismatches, 0, '--force restores anyway')
    assert.match(readFileSync(join(root, 'a.md'), 'utf8'), /original/)
  } finally { cleanup() }
})

test('review: emits the two-option card the agent must show', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a\n')
    run(['run', '--root', join(dir, 'docs'), 'init', '--run', 'r3'])
    write(dir, 'docs/01-系统设计.md', '# 系统设计\n')
    const r = run(['review', '--root', join(dir, 'docs'), '--run', 'r3'])
    assert.equal(r.code, 0)
    assert.equal(r.json.card.title, '整理完成 · 请先验收结果')
    assert.deepEqual(r.json.card.options.map((o) => o.value), ['confirm', 'restore'])
    assert.ok(r.json.card.options.some((o) => o.label.includes('恢复原状')))
    assert.ok(r.json.card.summary.length >= 3)
  } finally { cleanup() }
})

test('run confirm: marks the run so a later reader knows it was accepted', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/a.md', '# a\n')
    run(['run', '--root', join(dir, 'docs'), 'init', '--run', 'r4'])
    const c = run(['run', '--root', join(dir, 'docs'), 'confirm', '--run', 'r4'])
    assert.equal(c.code, 0)
    assert.equal(c.json.status, 'confirmed')
    const list = run(['run', '--root', join(dir, 'docs'), 'list'])
    assert.equal(list.json.runs[0].status, 'confirmed')
  } finally { cleanup() }
})

// ─────────────────────────── links ───────────────────────────

test('links: reports broken targets and never calls entry points orphans', () => {
  const { dir, cleanup } = tmp()
  try {
    write(dir, 'docs/README.md', '# 入口\n\n[设计](./design.md) 与 [坏的](./missing.md)\n')
    write(dir, 'docs/design.md', '# 设计\n')
    write(dir, 'docs/loose.md', '# 没人链接我\n')
    write(dir, 'docs/archive/old.md', '# 旧\n\n[指向已删除](../gone.md)\n')

    const r = run(['links', '--root', join(dir, 'docs')])
    assert.equal(r.code, 0)
    assert.equal(r.json.totals.broken, 2)
    assert.deepEqual(r.json.orphans, ['loose.md'])
    assert.deepEqual(r.json.entryPoints, ['README.md'])
  } finally { cleanup() }
})
