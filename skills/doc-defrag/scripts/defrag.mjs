#!/usr/bin/env node
/**
 * defrag.mjs — deterministic helpers for the doc-defrag skill.
 *
 * Zero dependencies. Node >= 20.
 *
 *   scan        fingerprint every .md, find duplicate clusters, collect type signals
 *   links       broken relative links + orphan pages, grouped (main docs vs archive)
 *   ledger      init a per-file disposition skeleton / check that every file has one
 *   docset      the confirmed document list: init / verify / atomic conditional writes
 *   relink      rewrite relative links whose target moved (dry-run by default)
 *
 * Design rules this file implements (see DESIGN.md §9):
 *   - never delete anything; archive only
 *   - metadata is written BEFORE any file is touched, atomically, with a precondition
 *   - any failure exits non-zero and leaves prior state intact
 */

import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const VERSION = '0.1.0'
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.defrag', '.idea', '.vscode', 'dist', 'build'])
const IGNORE_FILES = ['.DS_Store', '.localized']
const IGNORE_EXT = new Set(['.zstd', '.zip', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.mp4', '.mov'])
const DISPOSITIONS = ['merge', 'keep', 'archive', 'untouched']
const DISPOSITION_LABEL = { merge: '归并', keep: '保留', archive: '归档', untouched: '不动', TODO: 'TODO' }

// ─────────────────────────────── args ────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out.flags[key] = true
      else { out.flags[key] = next; i++ }
    } else out._.push(a)
  }
  return out
}

const fatal = (msg, code = 2) => { console.error(`defrag: ${msg}`); process.exit(code) }

// ───────────────────────────── file + hash helpers ────────────────────────────

function sha256(text) { return createHash('sha256').update(text, 'utf8').digest('hex') }
const sha256Short = (text) => sha256(text).slice(0, 12)

function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

/** POSIX-atomic write: tmp + fsync + rename. Never leaves a half-written file. */
function writeAtomic(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w')
  try { writeSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, p)
}

function ensureDir(p) { mkdirSync(p, { recursive: true }) }

/** Canonical, whitespace-stable text used for every fingerprint. */
function canon(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .normalize('NFKC')
    .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ─────────────────────────────── walking ─────────────────────────────────────

function toPosix(p) { return p.split(sep).join('/') }

function walkMd(root, { includeArchive = true } = {}) {
  const files = []
  const skipped = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name)
      const rel = toPosix(relative(root, abs))
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue
        if (!includeArchive && e.name === 'archive') { skipped.push({ path: rel, reason: 'archive excluded' }); continue }
        walk(abs)
        continue
      }
      if (!e.isFile()) continue
      if (IGNORE_FILES.includes(e.name)) { skipped.push({ path: rel, reason: 'noise file' }); continue }
      if (IGNORE_EXT.has(extname(e.name).toLowerCase())) { skipped.push({ path: rel, reason: 'binary/archive' }); continue }
      if (!/\.(md|markdown)$/i.test(e.name)) continue
      files.push({ rel, abs })
    }
  }
  walk(root)
  return { files, skipped }
}

// ─────────────────────────────── markdown parse ──────────────────────────────

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g
const WIKI_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

/**
 * Parse one markdown file. `fenceAware` skips fenced code, which is the correct
 * default; the naive mode reproduces the historical baseline scan.
 */
function parseMd(text, { fenceAware = true } = {}) {
  const lines = text.split('\n')
  let inFence = false
  let fenceMark = ''
  let inComment = false

  const headings = []
  const links = []
  const wiki = []
  const refs = []
  let title = null

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const lineNo = i + 1

    // fenced code tracking
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[2][0] }
      else if (fence[2][0] === fenceMark) { inFence = false }
      continue
    }
    if (inFence && fenceAware) continue

    // multi-line HTML comments
    if (fenceAware) {
      if (inComment) { if (line.includes('-->')) inComment = false; continue }
      const open = line.indexOf('<!--')
      if (open !== -1) {
        const close = line.indexOf('-->', open + 4)
        if (close === -1) { inComment = true; continue }
        line = line.slice(0, open) + line.slice(close + 3)
      }
    }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (h) {
      headings.push({ level: h[1].length, text: h[2].replace(/\s+#+\s*$/, '').trim(), line: lineNo })
      if (title === null && h[1].length === 1) title = headings[0].text
    }

    for (const m of line.matchAll(LINK_RE)) {
      links.push({ href: m[1].trim(), line: lineNo })
    }
    for (const m of line.matchAll(WIKI_RE)) {
      wiki.push({ target: m[1].trim(), line: lineNo })
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim()
      if (looksLikePath(tok)) refs.push({ token: tok, line: lineNo })
    }
  }
  return { title, headings, links, wiki, refs }
}

function looksLikePath(tok) {
  if (tok.length < 3 || tok.length > 200) return false
  if (/\s/.test(tok)) return false
  if (/^(https?:|mailto:)/i.test(tok)) return false
  return /\/|\.(?:md|markdown|json|yml|yaml|js|mjs|py|sh|ts|tsx|jsx|txt|csv|toml|ini|env|sql|html)$/i.test(tok)
}

// ─────────────────────────────── simhash ─────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = (1n << 64n) - 1n

function fnv1a64(str) {
  let h = FNV_OFFSET
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i))
    h = (h * FNV_PRIME) & MASK64
  }
  return h
}


/** Hashed character n-gram set, used to measure containment precisely (32-bit keys). */
function shingleSet(text, n = 5) {
  const s = canon(text).replace(/\s+/g, ' ')
  const out = new Set()
  if (s.length < n) { out.add(Number(fnv1a64(s) & 0xffffffffn)); return out }
  for (let i = 0; i + n <= s.length; i++) out.add(Number(fnv1a64(s.slice(i, i + n)) & 0xffffffffn))
  return out
}

/** How much of the smaller document also appears in the larger (0..1). */
function containment(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  if (!small.size) return 0
  let hit = 0
  for (const v of small) if (large.has(v)) hit++
  return hit / small.size
}

/** Two-stage near-duplicate detection: cheap SimHash/title filter, then exact containment. */
/** 64-bit SimHash over character 4-gram shingles (CJK-safe, no tokenizer). */
function simhash64(text, ngram = 4) {
  const s = canon(text).replace(/\s+/g, ' ')
  if (s.length < ngram) return fnv1a64(s)
  const vec = new Array(64).fill(0)
  for (let i = 0; i + ngram <= s.length; i++) {
    const h = fnv1a64(s.slice(i, i + ngram))
    for (let b = 0; b < 64; b++) vec[b] += (h >> BigInt(b)) & 1n ? 1 : -1
  }
  let out = 0n
  for (let b = 0; b < 64; b++) if (vec[b] > 0) out |= (1n << BigInt(b))
  return out
}

function hamming(a, b) {
  let x = a ^ b, n = 0
  while (x) { if (x & 1n) n++; x >>= 1n }
  return n
}

const hex64 = (v) => v.toString(16).padStart(16, '0')

// ─────────────────────────────── link resolve ───────────────────────────────

const isExternal = (href, naive = false) =>
  naive ? /^(?:https?:|mailto:|tel:)/i.test(href) : /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)

/**
 * Resolve a relative link target the way a Markdown renderer would.
 * `naive` reproduces the historical baseline scan (only http(s)/mailto/tel are external,
 * and no `.md` / `index.md` inference) so regressions can be compared like-for-like.
 */
function resolveLink(root, fromRel, href, { naive = false } = {}) {
  const clean = href.replace(/^<|>$/g, '').split('#')[0].split('?')[0].trim()
  if (!clean) return { kind: 'anchor-only', ok: true }
  if (isExternal(clean, naive)) return { kind: 'external', ok: true }
  const base = resolve(root, dirname(fromRel))
  const target = clean.startsWith('/') ? resolve(root, '.' + clean) : resolve(base, clean)
  const candidates = naive
    ? [target]
    : [target, target + '.md', target + '.markdown', join(target, 'index.md'), join(target, 'README.md')]
  for (const c of candidates) {
    if (existsSync(c)) return { kind: 'file', ok: true, target: toPosix(relative(root, c)) }
  }
  return { kind: 'missing', ok: false, target: toPosix(relative(root, target)) }
}

// ─────────────────────────────── signals ──────────────────────────────────────

const L1_MARKERS = [
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml',
  'Dockerfile', 'docker-compose.yml', 'compose.yml', 'compose.yaml', '.gitlab-ci.yml', 'Makefile',
]
const L2_KEYWORDS = {
  'software': ['adr', 'decisions', 'runbook', 'deploy', 'ops', 'api', 'architecture', 'src', 'tests', 'migrations', 'release', 'changelog'],
  'content-marketing': ['brief', 'style-guide', 'editorial', 'calendar', 'campaign', 'assets', 'posts', 'seo', 'brand', '选题', '文案', '稿件', '发布'],
  'legal-compliance': ['contract', 'matter', 'clause', 'memo', 'engagement', 'filing', 'compliance', '合同', '条款', '事务', '意见书', '合规'],
  'research': ['protocol', 'data-dictionary', 'codebook', 'experiment', 'analysis', 'lab', 'manuscript', 'literature', 'dataset', '实验', '样本', '数据字典', '文献'],
  'ops-quality': ['sop', 'wi', 'procedure', 'policy', 'manual', 'record', 'form', 'quality', 'iso', '程序书', '作业指导书', '记录'],
  'education': ['syllabus', 'lesson', 'curriculum', 'assessment', 'course', '大纲', '教案', '考核', '课程'],
  'engineering-aec': ['drawing', 'submittal', 'as-built', 'rfi', 'specification', '图纸', '竣工', '变更'],
}

function typeSignals(root, mdFiles, repoRoot = root) {
  const l1 = []
  for (const m of L1_MARKERS) if (existsSync(join(repoRoot, m))) l1.push(m)
  for (const d of ['src', 'tests', 'test', 'migrations', 'deploy', 'scripts', '.github', 'frappe', 'apps']) {
    if (existsSync(join(repoRoot, d)) && statSync(join(repoRoot, d)).isDirectory()) l1.push(`${d}/`)
  }

  const dirNames = new Set()
  for (const f of mdFiles) {
    const parts = f.rel.split('/')
    for (let i = 0; i < Math.max(1, parts.length - 1); i++) dirNames.add(parts[i].toLowerCase())
    dirNames.add(basename(parts[parts.length - 1], extname(parts[parts.length - 1])).toLowerCase())
  }

  const l2 = {}
  for (const [type, kws] of Object.entries(L2_KEYWORDS)) {
    const hits = []
    for (const d of dirNames) for (const k of kws) if (d.includes(k)) hits.push(d)
    if (hits.length) l2[type] = [...new Set(hits)].slice(0, 8)
  }

  const dated = mdFiles.filter((f) => /(?:19|20)\d{6}|(?:19|20)\d{2}-?\d{2}-?\d{2}/.test(f.rel)).length
  return {
    l1Markers: l1,
    l2DomainHits: l2,
    names: {
      mdFiles: mdFiles.length,
      datedNameRatio: mdFiles.length ? +(dated / mdFiles.length).toFixed(2) : 0,
      topDirs: [...new Set(mdFiles.map((f) => (f.rel.includes('/') ? f.rel.split('/')[0] : '(root)')))].slice(0, 12),
    },
  }
}

// ─────────────────────────────── commands ────────────────────────────────────

function cmdScan(root, flags) {
  const includeArchive = flags['include-archive'] === true
  const { files, skipped } = walkMd(root, { includeArchive })
  if (!files.length) fatal(`no markdown found under ${root}`)

  const docs = []
  for (const f of files) {
    const text = readText(f.abs) ?? ''
    const parsed = parseMd(text)
    const canonText = canon(text)
    docs.push({
      path: f.rel,
      bytes: Buffer.byteLength(text),
      mtime: statSync(f.abs).mtimeMs,
      sha256: sha256(canonText),
      simhash: hex64(simhash64(canonText)),
      title: parsed.title,
      headings: parsed.headings.length,
      links: parsed.links.length,
      refs: parsed.refs.length,
      inArchive: /(?:^|\/)archive\//.test(f.rel),
    })
  }

  // exact duplicates
  const bySha = new Map()
  for (const d of docs) {
    if (!bySha.has(d.sha256)) bySha.set(d.sha256, [])
    bySha.get(d.sha256).push(d.path)
  }
  const exactDupes = [...bySha.values()].filter((v) => v.length > 1).map((v) => ({ paths: v, count: v.length }))

  // Near duplicates: three cheap, interpretable candidate signals, then exact
  // shingle containment for precision. Every stage is bounded so a 300-file
  // corpus stays in the seconds range.
  const looseDist = Number(flags['near-dup-distance'] ?? 8)
  const maxPairs = Number(flags['max-pairs'] ?? 400)
  const shingleCache = new Map()
  const textCache = new Map()
  const normTitle = (d) => (d.title ?? '').replace(/\s+/g, '').toLowerCase()
  const stem = (p) => basename(p).replace(/\.(md|markdown)$/i, '')
    .replace(/[_-]?(?:\d{4,8}|\d{2,4}-\d{2}-\d{2}|final|old|v\d+|copy|副本|最终|终版)\b/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
  const stemScore = (a, b) => {
    if (!a || !b) return 0
    const [s, l] = a.length <= b.length ? [a, b] : [b, a]
    if (s === l) return 1
    return s.length >= 3 && l.includes(s) ? s.length / l.length : 0
  }
  const shingles = (path) => {
    if (!shingleCache.has(path)) {
      if (!textCache.has(path)) textCache.set(path, canon(readText(resolve(root, path)) ?? ''))
      shingleCache.set(path, shingleSet(textCache.get(path)))
    }
    return shingleCache.get(path)
  }

  const candidates = []
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const A = docs[i], B = docs[j]
      const dist = hamming(BigInt('0x' + A.simhash), BigInt('0x' + B.simhash))
      const sameTitle = Boolean(normTitle(A)) && normTitle(A) === normTitle(B)
      const ss = stemScore(stem(A.path), stem(B.path))
      if (!sameTitle && ss < 0.5 && dist > looseDist) continue
      candidates.push({ A, B, dist, sameTitle, ss })
    }
  }
  candidates.sort((x, y) => (Number(y.sameTitle) - Number(x.sameTitle)) || y.ss - x.ss || x.dist - y.dist)

  const pairs = []
  for (const c of candidates.slice(0, maxPairs)) {
    const ca = containment(shingles(c.A.path), shingles(c.B.path))
    if (ca < 0.35) continue
    pairs.push({
      a: c.A.path, b: c.B.path, distance: c.dist,
      containment: +ca.toFixed(3),
      sameTitle: c.sameTitle,
      filenameAffinity: +c.ss.toFixed(2),
      band: ca >= 0.8 ? 'high' : ca >= 0.5 ? 'medium' : 'low',
    })
  }
  pairs.sort((x, y) => y.containment - x.containment || x.distance - y.distance || x.a.localeCompare(y.a))
  const out = {
    version: VERSION,
    root,
    scannedAt: flags['no-clock'] ? 'fixed' : new Date().toISOString(),
    counts: {
      mdFiles: docs.length,
      inArchive: docs.filter((d) => d.inArchive).length,
      totalBytes: docs.reduce((s, d) => s + d.bytes, 0),
    },
    signals: {
      ...typeSignals(root, files.map((f) => ({ rel: f.rel })), flags.repo ? resolve(flags.repo) : root),
      repoRoot: flags.repo ? toPosix(flags.repo) : null,
    },
    exactDuplicates: exactDupes,
    nearDuplicatePairs: pairs.slice(0, 200),
    nearDuplicateCount: pairs.length,
    nearDuplicateCandidates: candidates.length,
    files: docs.sort((a, b) => a.path.localeCompare(b.path)),
    skipped,
  }
  return out
}

function cmdLinks(root, flags) {
  const includeArchive = flags['include-archive'] !== false
  const naive = flags['naive-links'] === true
  const { files } = walkMd(root, { includeArchive })

  const parsed = new Map()
  for (const f of files) parsed.set(f.rel, parseMd(readText(f.abs) ?? '', { fenceAware: !naive }))

  const broken = []
  const total = { main: 0, archive: 0 }
  let inbound = new Map()

  for (const f of files) {
    const isArchive = /(?:^|\/)archive\//.test(f.rel)
    const p = parsed.get(f.rel)
    for (const l of p.links) {
      const r = resolveLink(root, f.rel, l.href, { naive })
      if (r.kind === 'external' || r.kind === 'anchor-only') continue
      total[isArchive ? 'archive' : 'main']++
      if (r.kind === 'missing') broken.push({ file: f.rel, line: l.line, href: l.href, resolved: r.target, group: isArchive ? 'archive' : 'main' })
      else if (r.target) inbound.set(r.target, (inbound.get(r.target) ?? 0) + 1)
    }
    for (const w of p.wiki) {
      const base = w.target.replace(/\\/g, '/').split('/').pop()
      const hit = files.find((g) => basename(g.rel).replace(/\.(md|markdown)$/i, '') === base)
      if (hit) { total[isArchive ? 'archive' : 'main']++; inbound.set(hit.rel, (inbound.get(hit.rel) ?? 0) + 1) }
      else broken.push({ file: f.rel, line: w.line, href: `[[${w.target}]]`, resolved: w.target, group: isArchive ? 'archive' : 'main' })
    }
  }

  const entryPoints = files.filter((f) => /^(README|index|AGENTS|CLAUDE|CONTRIBUTING)\.md$/i.test(basename(f.rel)))
  const orphans = files
    .filter((f) => !/(?:^|\/)archive\//.test(f.rel))
    .filter((f) => (inbound.get(f.rel) ?? 0) === 0)
    .filter((f) => !entryPoints.some((e) => e.rel === f.rel))
    .map((f) => f.rel)

  return {
    version: VERSION,
    root,
    naive,
    totals: { ...total, broken: broken.length, files: files.length },
    broken,
    orphans,
    entryPoints: entryPoints.map((e) => e.rel),
  }
}

function cmdLedger(root, flags) {
  const mode = flags.mode ?? (flags.check ? 'check' : 'init')
  const outPath = resolve(root, flags.out ?? join('.defrag', 'ledger.md'))
  const { files } = walkMd(root)

  if (mode === 'init') {
    if (existsSync(outPath) && flags.force !== true) {
      fatal(`ledger already exists: ${outPath} (use --force to replace, or --check to verify)`)
    }
    const runId = flags['run-id'] ?? (flags['no-clock'] ? 'fixed' : new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
    const lines = [
      `# 逐文件归属表（run ${runId}）`,
      '',
      '> 每个 .md 必须有一行归属；`state` 取 `merge | keep | archive | untouched`。',
      '> `target` 对 merge/archive/untouched 必填（目标文件或目录），keep 可写 `—`。',
      '',
      '| # | file | state | target | reason |',
      '|---|---|---|---|---|',
    ]
    files.forEach((f, i) => lines.push(`| ${i + 1} | ${f.rel} | TODO |  |  |`))
    ensureDir(dirname(outPath))
    writeAtomic(outPath, lines.join('\n') + '\n')
    return { version: VERSION, wrote: toPosix(relative(root, outPath)), files: files.length }
  }

  // check
  if (!existsSync(outPath)) fatal(`ledger not found: ${outPath}`)
  const rows = parseLedger(readText(outPath) ?? '')
  const problems = []
  const seen = new Set()
  for (const r of rows) {
    seen.add(r.file)
    if (r.state === 'TODO' || !r.state) problems.push({ file: r.file, problem: 'pending', detail: 'state 仍为 TODO' })
    else if (!DISPOSITIONS.includes(r.state)) problems.push({ file: r.file, problem: 'bad-state', detail: r.state })
    else if (r.state !== 'keep' && !r.target) problems.push({ file: r.file, problem: 'missing-target', detail: '非 keep 必须填 target' })
  }
  for (const f of files) if (!seen.has(f.rel)) problems.push({ file: f.rel, problem: 'missing-row', detail: '无归属行' })
  for (const r of rows) if (!existsSync(resolve(root, r.file))) problems.push({ file: r.file, problem: 'gone', detail: '台账里的文件已不存在' })

  const resolved = rows.filter((r) => r.state && r.state !== 'TODO').length
  return {
    version: VERSION,
    ledger: toPosix(relative(root, outPath)),
    counts: { rows: rows.length, resolved, files: files.length },
    coverageRatio: files.length ? +(resolved / files.length).toFixed(4) : 1,
    problems,
    ok: problems.length === 0,
  }
}

function parseLedger(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''))
    if (cells.length < 4) continue
    if (/^#?$/.test(cells[0]) || /^-+$/.test(cells[1] ?? '')) continue
    // accept both 5-col (with #) and 4-col
    const [, file, state, target, reason] = cells.length >= 5
      ? cells
      : [null, ...cells]
    if (!file || file === 'file') continue
    rows.push({ file, state: (state ?? '').toUpperCase() === 'TODO' ? 'TODO' : (state ?? '').toLowerCase(), target: target ?? '', reason: reason ?? '' })
  }
  return rows
}

// ─────────────────────────────── docset ──────────────────────────────────────

const DOCSET_REL = join('.defrag', 'docset.json')
const HISTORY_REL = join('.defrag', 'history')
const LOCK_REL = join('.defrag', '.lock')

function docsetPath(root) { return join(root, DOCSET_REL) }

function canonicalJson(obj) { return JSON.stringify(sortDeep(obj)) }
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k])
    return out
  }
  return v
}
// The checksum covers the payload only: the sha256 field itself is excluded,
// so a written file always verifies against itself.
const docsetSha = (obj) => {
  const { sha256: _ignored, ...payload } = obj ?? {}
  return sha256(canonicalJson(payload))
}

function validateDocset(d) {
  const errs = []
  if (!d || typeof d !== 'object') return ['docset is not an object']
  if (!Number.isInteger(d.revision) || d.revision < 1) errs.push('revision must be a positive integer')
  if (!Array.isArray(d.docs) || d.docs.length === 0) errs.push('docs must be a non-empty array')
  else {
    d.docs.forEach((doc, i) => {
      if (!doc || typeof doc.file !== 'string' || !doc.file) errs.push(`docs[${i}].file is required`)
      if (doc && typeof doc.name !== 'string') errs.push(`docs[${i}].name is required`)
      if (doc && doc.scopeMissing !== true && typeof doc.scope !== 'string') errs.push(`docs[${i}].scope missing (or set scopeMissing:true)`)
    })
    const files = d.docs.map((x) => x.file)
    const dup = files.filter((f, i) => files.indexOf(f) !== i)
    if (dup.length) errs.push(`duplicate target files: ${dup.join(', ')}`)
  }
  if (d.exclude !== undefined && !Array.isArray(d.exclude)) errs.push('exclude must be an array')
  if (d.perModule !== undefined && !Array.isArray(d.perModule)) errs.push('perModule must be an array')
  return errs
}

function loadDocset(root) {
  const p = docsetPath(root)
  if (!existsSync(p)) return { exists: false }
  let raw
  try { raw = readText(p) } catch (e) { throw new Error(`cannot read docset: ${e.message}`) }
  let d
  try { d = JSON.parse(raw) } catch (e) {
    throw new Error(`docset.json is not valid JSON (${e.message}); fix it or restore a history snapshot — refusing to fall back to defaults`)
  }
  const errs = validateDocset(d)
  if (errs.length) throw new Error(`docset.json failed validation: ${errs.join('; ')} — refusing to fall back to defaults`)
  const computed = docsetSha(d)
  if (d.sha256 && d.sha256 !== computed) throw new Error(`docset.json checksum mismatch (claim ${d.sha256}, actual ${computed}) — file was edited outside the protocol; run \`docset verify\` and restore a history snapshot`)
  return { exists: true, docset: d, path: p }
}

function readLock(root) {
  const p = join(root, LOCK_REL)
  if (!existsSync(p)) return null
  try { return JSON.parse(readText(p) ?? '{}') } catch { return { pid: 0, startedAt: 0 } }
}

function acquireLock(root, { staleMs = 10 * 60 * 1000 } = {}) {
  const p = join(root, LOCK_REL)
  const now = Date.now()
  const existing = readLock(root)
  if (existing) {
    const age = now - (existing.startedAt ?? 0)
    if (age < staleMs && existing.pid && existing.pid !== process.pid) {
      throw new Error(`another defrag run holds the lock (pid ${existing.pid}, ${Math.round(age / 1000)}s ago). Wait, or break it explicitly with --break-lock`)
    }
  }
  ensureDir(dirname(p))
  writeAtomic(p, JSON.stringify({ pid: process.pid, host: process.env.HOSTNAME ?? 'local', startedAt: now }))
  return { release: () => { try { unlinkSync(p) } catch {} } }
}

function snapshotHistory(root, docset) {
  const dir = join(root, HISTORY_REL)
  ensureDir(dir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = join(dir, `docset-${stamp}-r${docset.revision}.json`)
  writeAtomic(file, JSON.stringify(docset, null, 2) + '\n')
  return toPosix(relative(root, file))
}

function gitIgnored(root, rel) {
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', rel], { encoding: 'utf8' })
  if (r.error || r.status === 128) return 'unknown' // no git / not a repo
  return r.status === 0
}

function cmdDocset(root, flags) {
  const mode = flags.mode ?? 'verify'
  const wantRevision = flags['if-revision'] !== undefined ? Number(flags['if-revision']) : undefined

  if (mode === 'verify') {
    let loaded
    try { loaded = loadDocset(root) } catch (e) { return { ok: false, problems: [{ problem: 'load', detail: e.message }] } }
    if (!loaded.exists) return { ok: false, problems: [{ problem: 'missing', detail: `${DOCSET_REL} not found` }] }
    const d = loaded.docset
    const problems = []
    for (const doc of d.docs) {
      if (!existsSync(resolve(root, doc.file))) problems.push({ problem: 'missing-target-file', detail: doc.file })
      if (doc.scopeMissing === true) problems.push({ problem: 'scope-missing', detail: `${doc.file} (scope 待补)` })
    }
    const ign = gitIgnored(root, toPosix(DOCSET_REL))
    if (ign === true) problems.push({ problem: 'gitignored', detail: `${DOCSET_REL} 被 .gitignore 忽略，清单会随 clone 丢失；建议 git add -f` })
    const hist = existsSync(join(root, HISTORY_REL)) ? readdirSync(join(root, HISTORY_REL)).filter((f) => f.startsWith('docset-')).length : 0
    return {
      ok: problems.length === 0,
      path: toPosix(DOCSET_REL),
      revision: d.revision,
      sha256: d.sha256 ?? docsetSha(d),
      filesTracked: filesTracked(root, DOCSET_REL),
      historySnapshots: hist,
      problems,
    }
  }

  if (mode === 'init' || mode === 'set') {
    const lock = acquireLock(root, { staleMs: flags['break-lock'] === true ? 0 : undefined })
    try {
      const existing = loadDocset(root)
      if (mode === 'init' && existing.exists && flags.force !== true) {
        throw new Error(`${DOCSET_REL} already exists (revision ${existing.docset.revision}). Use \`docset set --if-revision N\` to change it — refusing to overwrite a user-confirmed list`)
      }
      let next
      if (flags.file) {
        try { next = JSON.parse(readText(resolve(root, flags.file)) ?? '') } catch (e) { throw new Error(`cannot parse ${flags.file}: ${e.message}`) }
      } else {
        throw new Error('provide --file <json> with the confirmed list')
      }
      if (existing.exists) {
        if (wantRevision === undefined) throw new Error('changing an existing docset requires --if-revision <current revision> (precondition)')
        if (wantRevision !== existing.docset.revision) {
          throw new Error(`precondition failed: docset is at revision ${existing.docset.revision}, not ${wantRevision}. Someone changed it — show the diff and let the user decide`)
        }
        if (flags.force !== true && next.docs.length !== existing.docset.docs.length) {
          // not a hard error; just visible
        }
      }
      next.revision = existing.exists ? existing.docset.revision + 1 : 1
      next.version = next.version ?? 1
      next.confirmedAt = next.confirmedAt ?? new Date().toISOString().slice(0, 10)
      const errs = validateDocset(next)
      if (errs.length) throw new Error(`refusing to write invalid docset: ${errs.join('; ')}`)
      next.sha256 = docsetSha(next)

      let historyFile = null
      if (existing.exists) historyFile = snapshotHistory(root, existing.docset)

      writeAtomic(docsetPath(root), JSON.stringify(next, null, 2) + '\n')
      // read-back verification
      const back = loadDocset(root)
      if (docsetSha(back.docset) !== next.sha256) throw new Error('read-back checksum mismatch after write — the file is not what we wrote')
      return { ok: true, path: toPosix(DOCSET_REL), revision: next.revision, sha256: next.sha256, history: historyFile, previousRevision: existing.exists ? existing.docset.revision : null }
    } finally { lock.release() }
  }

  throw new Error(`unknown docset mode: ${mode} (expected verify|init|set)`)
}

function filesTracked(root, rel) {
  const r = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', rel], { encoding: 'utf8' })
  if (r.error) return 'unknown'
  return r.status === 0
}

// ─────────────────────────────── relink ───────────────────────────────────────

/**
 * archive: the ONLY destructive-looking operation in this tool — and it is a move,
 * never a delete. Refuses to overwrite an existing target, refuses to move into
 * anything but the archive root, and records the from→to map for relink.
 *
 *   defrag archive --root <dir> --plan plan.json [--apply]
 *   plan = { "archiveRoot": "docs/archive", "moves": [ { "from": "docs/ops/a.md", "to": "docs/archive/ops/a.md" } ] }
 */
function cmdArchive(root, flags) {
  const planPath = resolve(root, flags.plan ?? '')
  if (!flags.plan || !existsSync(planPath)) fatal('archive needs --plan <json>')
  let plan
  try { plan = JSON.parse(readText(planPath) ?? '') } catch (e) { fatal(`cannot parse plan: ${e.message}`) }
  const archiveRoot = (plan.archiveRoot ?? 'docs/archive').replace(/\/$/, '')
  const moves = Array.isArray(plan.moves) ? plan.moves : []
  if (!moves.length) fatal('plan.moves is empty')

  const problems = []
  for (const m of moves) {
    if (!m || !m.from || !m.to) { problems.push({ move: m, problem: 'bad-shape', detail: 'from/to required' }); continue }
    const from = resolve(root, m.from)
    const to = resolve(root, m.to)
    if (!existsSync(from)) problems.push({ move: m.from, problem: 'source-missing' })
    else if (statSync(from).isDirectory()) problems.push({ move: m.from, problem: 'is-directory', detail: '只搬文件；目录请逐文件列出' })
    if (existsSync(to)) problems.push({ move: m.to, problem: 'target-exists', detail: '不覆盖任何已存在的文件' })
    if (!toPosix(relative(root, to)).startsWith(archiveRoot + '/')) problems.push({ move: m.to, problem: 'outside-archive-root', detail: `必须在 ${archiveRoot}/ 下` })
    if (toPosix(relative(root, from)).startsWith(archiveRoot + '/')) problems.push({ move: m.from, problem: 'already-archived' })
  }
  if (problems.length) return { ok: false, apply: false, problems, counts: { moves: moves.length } }

  if (flags.apply !== true) {
    return { ok: true, apply: false, dryRun: true, archiveRoot, counts: { moves: moves.length }, sample: moves.slice(0, 10) }
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (const m of moves) {
    const from = resolve(root, m.from)
    const to = resolve(root, m.to)
    ensureDir(dirname(to))
    renameSync(from, to)
    if (flags.run) appendAction(root, flags.run, { kind: 'move', from: toPosix(m.from), to: toPosix(m.to) })
  }
  const mapPath = join(root, '.defrag', 'moves', `moves-${runId}.json`)
  writeAtomic(mapPath, JSON.stringify({ runId, archiveRoot, moves }, null, 2) + '\n')

  const verified = moves.filter((m) => !existsSync(resolve(root, m.from)) && existsSync(resolve(root, m.to))).length
  return {
    ok: verified === moves.length,
    apply: true,
    runId,
    archiveRoot,
    movesFile: toPosix(relative(root, mapPath)),
    counts: { moves: moves.length, verified },
    deleted: 0,
  }
}

/** relink: rewrite relative links whose target moved, using the archive move map. */
function cmdRelink(root, flags) {
  let movesFile = flags.moves ? resolve(root, flags.moves) : null
  if (!movesFile) {
    const dir = join(root, '.defrag', 'moves')
    if (!existsSync(dir)) fatal('no move map found: run `archive --apply` first, or pass --moves <file>')
    const filesIn = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    if (!filesIn.length) fatal('no move map found in .defrag/moves')
    movesFile = join(dir, filesIn[filesIn.length - 1])
  }
  const map = JSON.parse(readText(movesFile) ?? '{}')
  const moves = new Map()
  for (const m of map.moves ?? []) moves.set(toPosix(m.from), toPosix(m.to))
  if (!moves.size) return { version: VERSION, moves: 0, rewrites: [], count: 0 }

  const { files } = walkMd(root)
  const rewrites = []
  for (const f of files) {
    const text = readText(f.abs) ?? ''
    let out = text
    for (const l of parseMd(text).links) {
      const r = resolveLink(root, f.rel, l.href)
      if (r.kind !== 'missing') continue
      const moved = moves.get(r.target)
      if (!moved) continue
      let newHref = toPosix(relative(dirname(f.abs), resolve(root, moved)))
      if (!newHref.startsWith('.')) newHref = './' + newHref
      if (l.href.includes('#')) newHref += '#' + l.href.split('#').slice(1).join('#')
      out = out.split(`](${l.href})`).join(`](${newHref})`)
      rewrites.push({ file: f.rel, line: l.line, from: l.href, to: newHref })
    }
    if (out !== text && flags.apply === true) {
      if (flags.run) backupOnce(root, flags.run, f.rel)
      writeAtomic(f.abs, out)
      if (flags.run) {
        const j = loadJournal(root, flags.run)
        const last = [...j.actions].reverse().find((a) => a.kind === 'edit' && a.path === f.rel)
        if (last) { last.afterSha = rawSha(f.abs); saveJournal(root, flags.run, j) }
      }
    }
  }
  return { version: VERSION, apply: flags.apply === true, moves: moves.size, count: rewrites.length, rewrites }
}

// ─────────────────────────────── main ──────────────────────────────────────

// ─────────────────────────── run journal + undo ──────────────────────────────
//
// Every run must be reversible WITHOUT git: before the first byte is touched we
// snapshot the whole tree (relative path + raw sha256), then every mutation is
// appended to an append-only journal:
//   move : {from, to}                  archive moves
//   edit : {path, backup, beforeSha}   in-place edits (link rewrites, banners)
// created files are derived by diffing the live tree against the before-image.
// Undo reverses moves and edits, and moves created files into
// .defrag/runs/<id>/created/ — nothing is ever deleted.

const RUNS_REL = join('.defrag', 'runs')
const runDir = (root, id) => join(root, RUNS_REL, id)
const rawSha = (abs) => {
  try { return sha256(readFileSync(abs).toString('binary')) } catch { return null }
}
const safeName = (rel) => rel.replace(/[\\/]/g, '__')
// Only documents count as "created" for review/undo; helper JSON (plans, probes)
// is transient coordination state, not user content.
const isDoc = (p) => /\.(md|markdown)$/i.test(p)

function walkAllFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue
        walk(abs); continue
      }
      if (!e.isFile()) continue
      if (IGNORE_FILES.includes(e.name)) continue
      if (IGNORE_EXT.has(extname(e.name).toLowerCase())) continue
      const rel = toPosix(relative(root, abs))
      out.push({ path: rel, bytes: statSync(abs).size, sha256: rawSha(abs) })
    }
  }
  walk(root)
  return out
}

function loadJournal(root, id) {
  const p = join(runDir(root, id), 'journal.json')
  if (!existsSync(p)) throw new Error(`no run journal for ${id} (expected ${toPosix(relative(root, p))})`)
  return JSON.parse(readText(p) ?? '{}')
}

function saveJournal(root, id, journal) {
  journal.updatedAt = new Date().toISOString()
  writeAtomic(join(runDir(root, id), 'journal.json'), JSON.stringify(journal, null, 2) + '\n')
}

function appendAction(root, id, action) {
  const journal = loadJournal(root, id)
  journal.actions.push({ ...action, at: new Date().toISOString() })
  saveJournal(root, id, journal)
  return journal
}

function cmdRun(root, flags) {
  const mode = flags.mode ?? 'list'
  const id = flags.run

  if (mode === 'list') {
    const dir = join(root, RUNS_REL)
    if (!existsSync(dir)) return { version: VERSION, runs: [] }
    const runs = readdirSync(dir)
      .filter((d) => existsSync(join(dir, d, 'journal.json')))
      .sort()
      .map((d) => {
        const j = JSON.parse(readText(join(dir, d, 'journal.json')) ?? '{}')
        return {
          runId: d, createdAt: j.createdAt, status: j.status ?? 'pending',
          actions: (j.actions ?? []).length,
        }
      })
    return { version: VERSION, runs }
  }

  if (!id) throw new Error('run id required (--run <id>)')

  if (mode === 'init') {
    const lock = acquireLock(root)
    try {
      const dir = runDir(root, id)
      if (existsSync(join(dir, 'journal.json')) && flags.force !== true) {
        throw new Error(`run ${id} already exists; use --force to replace`)
      }
      const before = { createdAt: new Date().toISOString(), root, files: walkAllFiles(root) }
      ensureDir(dir)
      writeAtomic(join(dir, 'before.json'), JSON.stringify(before, null, 2) + '\n')
      const journal = {
        schema: 'doc-defrag-run/1', runId: id, root,
        createdAt: before.createdAt, status: 'open', actions: [],
      }
      saveJournal(root, id, journal)
      return { ok: true, runId: id, files: before.files.length, dir: toPosix(relative(root, dir)) }
    } finally { lock.release() }
  }

  if (mode === 'seal') {
    const journal = loadJournal(root, id)
    let stamped = 0
    for (const a of journal.actions.filter((x) => x.kind === 'edit')) {
      if (a.afterSha) continue
      const abs = resolve(root, a.path)
      if (existsSync(abs)) { a.afterSha = rawSha(abs); stamped++ }
    }
    journal.sealedAt = new Date().toISOString()
    saveJournal(root, id, journal)
    return { ok: true, runId: id, stamped, status: journal.status ?? 'open' }
  }

  if (mode === 'confirm') {
    const journal = loadJournal(root, id)
    journal.status = 'confirmed'
    journal.confirmedAt = new Date().toISOString()
    saveJournal(root, id, journal)
    return { ok: true, runId: id, status: 'confirmed' }
  }

  throw new Error(`unknown run mode: ${mode} (expected list|init|confirm)`)
}

/** Copy a file into the run's orig/ dir once, and journal that edit. */
function backupOnce(root, id, rel) {
  const abs = resolve(root, rel)
  if (!existsSync(abs)) throw new Error(`cannot back up missing path: ${rel}`)
  const journal = loadJournal(root, id)
  const already = journal.actions.find((a) => a.kind === 'edit' && a.path === toPosix(rel))
  if (already) return { backup: already.backup, beforeSha: already.beforeSha, alreadyBackedUp: true }
  const beforeSha = rawSha(abs)
  const backupRel = toPosix(join(RUNS_REL, id, 'orig', safeName(toPosix(rel))))
  const backupAbs = join(root, backupRel)
  ensureDir(dirname(backupAbs))
  copyFileSync(abs, backupAbs)
  appendAction(root, id, { kind: 'edit', path: toPosix(rel), backup: backupRel, beforeSha })
  return { backup: backupRel, beforeSha, alreadyBackedUp: false }
}

/** Backup an existing file before the agent edits it by hand. */
function cmdBackup(root, flags) {
  const id = flags.run
  if (!id) throw new Error('backup needs --run <id>')
  const rel = flags.path
  if (!rel) throw new Error('backup needs --path <relative path>')
  const r = backupOnce(root, id, rel)
  return { ok: true, runId: id, path: toPosix(rel), ...r }
}

function cmdReview(root, flags) {
  const id = flags.run
  if (!id) throw new Error('review needs --run <id>')
  const journal = loadJournal(root, id)
  let before
  try { before = JSON.parse(readText(join(runDir(root, id), 'before.json')) ?? '{}') } catch { before = {} }
  const live = walkAllFiles(root)
  const beforeMap = new Map((before.files ?? []).map((f) => [f.path, f.sha256]))
  const liveMap = new Map(live.map((f) => [f.path, f.sha256]))

  const movedTargets = new Set((journal.actions ?? []).filter((a) => a.kind === 'move').map((a) => a.to))
  const created = live.filter((f) => !beforeMap.has(f.path) && !movedTargets.has(f.path) && isDoc(f.path))
  const missing = (before.files ?? []).filter((f) => !liveMap.has(f.path))
  const changed = live.filter((f) => beforeMap.has(f.path) && beforeMap.get(f.path) !== f.sha256)

  let docset = null
  try { docset = loadDocset(root).docset ?? null } catch { docset = null }

  // files the agent was unsure about were archived on purpose; surface the count
  let uncertain = 0
  const ledgerPath = join(root, '.defrag', 'ledger.md')
  if (existsSync(ledgerPath)) {
    try {
      uncertain = parseLedger(readText(ledgerPath) ?? '')
        .filter((r) => (r.reason ?? '').includes('拿不准')).length
    } catch { uncertain = 0 }
  }

  const summary = [
    `权威文档 ${docset?.docs?.length ?? 0} 份`,
    `新建 ${created.length} 个文件`,
    `归档 ${missing.length} 个文件（未删除，全部在 archive/ 下）`,
    `改动 ${changed.length} 个文件`,
  ]
  if (uncertain > 0) summary.push(`拿不准已归档 ${uncertain} 个（想捞回哪个说一声）`)

  return {
    ok: true,
    runId: id,
    status: journal.status ?? 'pending',
    card: {
      header: '整理完成 · 请先验收结果',
      title: '整理完成 · 请先验收结果',
      summary,
      lookAt: [
        ...(docset?.docs ?? []).map((d) => d.file),
        'docs/README.md',
        'docs/archive/index.md',
        `.defrag/runs/${id}/journal.json`,
      ],
      options: [
        { label: '确认，保留整理结果', value: 'confirm' },
        { label: '恢复原状', value: 'restore' },
      ],
      counts: { created: created.length, archived: missing.length, changed: changed.length },
    },
  }
}

function cmdUndo(root, flags) {
  const id = flags.run
  if (!id) throw new Error('undo needs --run <id>')
  const journal = loadJournal(root, id)
  let before
  try { before = JSON.parse(readText(join(runDir(root, id), 'before.json')) ?? '{}') } catch { before = {} }
  const live = walkAllFiles(root)
  const beforeMap = new Map((before.files ?? []).map((f) => [f.path, f]))
  const liveMap = new Map(live.map((f) => [f.path, f]))

  const plan = { movesBack: [], editsBack: [], createdAside: [], skipped: [] }

  // 1. moves: put every archived file back at its original path
  for (const a of journal.actions.filter((x) => x.kind === 'move')) {
    const fromAbs = resolve(root, a.from), toAbs = resolve(root, a.to)
    if (existsSync(toAbs) && !existsSync(fromAbs)) plan.movesBack.push({ from: a.to, to: a.from })
    else if (existsSync(fromAbs)) plan.skipped.push({ path: a.from, reason: 'already at original path' })
    else plan.skipped.push({ path: a.to, reason: 'archived file is gone; nothing to move back' })
  }

  // 2. edits: restore backups, but never clobber a later hand edit
  for (const a of journal.actions.filter((x) => x.kind === 'edit')) {
    const abs = resolve(root, a.path)
    const backupAbs = resolve(root, a.backup)
    if (!existsSync(backupAbs)) { plan.skipped.push({ path: a.path, reason: 'backup missing' }); continue }
    const nowSha = existsSync(abs) ? rawSha(abs) : null
    const backupSha = rawSha(backupAbs)
    if (nowSha === backupSha) { plan.skipped.push({ path: a.path, reason: 'already original' }); continue }
    if (a.afterSha && nowSha && nowSha !== a.afterSha && flags.force !== true) {
      plan.skipped.push({ path: a.path, reason: 'changed after the run; restore with --force if that is what you want' })
      continue
    }
    plan.editsBack.push({ path: a.path, backup: a.backup, fromSha: nowSha, toSha: backupSha })
  }

  // 3. created: move aside (never delete)
  const movedTargets = new Set(journal.actions.filter((a) => a.kind === 'move').map((a) => a.to))
  for (const f of live) {
    if (beforeMap.has(f.path) || movedTargets.has(f.path) || !isDoc(f.path)) continue
    plan.createdAside.push({ path: f.path })
  }

  if (flags.apply !== true) {
    return {
      ok: true, apply: false, runId: id, plan,
      counts: {
        movesBack: plan.movesBack.length, editsBack: plan.editsBack.length,
        createdAside: plan.createdAside.length, skipped: plan.skipped.length,
      },
    }
  }

  const lock = acquireLock(root)
  try {
    const sideDir = toPosix(join(RUNS_REL, id, 'created'))
    for (const e of plan.editsBack) writeAtomic(resolve(root, e.path), readFileSync(resolve(root, e.backup)))
    for (const m of plan.movesBack) {
      const fromAbs = resolve(root, m.from), toAbs = resolve(root, m.to)
      ensureDir(dirname(toAbs))
      renameSync(fromAbs, toAbs)
    }
    for (const c of plan.createdAside) {
      const fromAbs = resolve(root, c.path)
      const toAbs = join(root, sideDir, safeName(c.path))
      ensureDir(dirname(toAbs))
      renameSync(fromAbs, toAbs)
    }

    // Remove directories this run created for the moves, once they are empty.
    // An empty directory holds no document, so nothing is lost; only paths that
    // appear as a move target's ancestors are considered.
    let dirsRemoved = 0
    const candidateDirs = new Set()
    for (const a of journal.actions.filter((x) => x.kind === 'move')) {
      let d = dirname(a.to)
      while (d && d !== '.' && d.length > 2) { candidateDirs.add(d); d = dirname(d) }
    }
    for (const d of [...candidateDirs].sort((a, b) => b.length - a.length)) {
      const abs = join(root, d)
      try {
        if (existsSync(abs) && statSync(abs).isDirectory() && readdirSync(abs).length === 0) {
          rmdirSync(abs); dirsRemoved++
        }
      } catch { /* leave it */ }
    }

    const after = walkAllFiles(root)
    const afterMap = new Map(after.map((f) => [f.path, f.sha256]))
    const mismatches = []
    for (const [path, f] of beforeMap) {
      if (afterMap.get(path) !== f.sha256) {
        mismatches.push({ path, problem: afterMap.has(path) ? 'content-differs' : 'still-missing' })
      }
    }
    journal.status = 'restored'
    journal.restoredAt = new Date().toISOString()
    journal.restoreReport = { mismatches, createdAsideDir: sideDir }
    saveJournal(root, id, journal)

    return {
      ok: mismatches.length === 0,
      apply: true, runId: id,
      counts: {
        movesBack: plan.movesBack.length, editsBack: plan.editsBack.length,
        createdAside: plan.createdAside.length, mismatches: mismatches.length,
      },
      mismatches, createdAsideDir: sideDir, dirsRemoved, deleted: 0,
    }
  } finally { lock.release() }
}

function main() {
  const argv = process.argv.slice(2)
  const { _: positional, flags } = parseArgs(argv)
  const cmd = positional[0]
  const root = resolve(flags.root ?? '.')
  if (!existsSync(root)) fatal(`root not found: ${root}`)

  let out
  try {
    switch (cmd) {
      case 'scan': out = cmdScan(root, flags); break
      case 'links': out = cmdLinks(root, flags); break
      case 'ledger': out = cmdLedger(root, { ...flags, mode: flags.mode ?? (flags.check === true || positional[1] === 'check' ? 'check' : 'init') }); break
      case 'docset': out = cmdDocset(root, { ...flags, mode: flags.mode ?? positional[1] ?? 'verify' }); break
      case 'run': out = cmdRun(root, { ...flags, mode: flags.mode ?? positional[1] ?? 'list' }); break
      case 'backup': out = cmdBackup(root, flags); break
      case 'review': out = cmdReview(root, flags); break
      case 'undo': out = cmdUndo(root, flags); break
      case 'archive': out = cmdArchive(root, flags); break
      case 'relink': out = cmdRelink(root, flags); break
      default:
        console.error(`defrag ${VERSION}\n\nusage:\n  defrag scan   --root <dir> [--include-archive] [--near-dup-distance 6] [--json]\n  defrag links  --root <dir> [--naive-links]\n  defrag ledger --root <dir> [--check] [--out .defrag/ledger.md] [--force]\n  defrag docset --root <dir> [verify | init --file f.json | set --file f.json --if-revision N]\n  defrag archive --root <dir> --plan plan.json [--apply]\n  defrag relink --root <dir> [--moves .defrag/moves/*.json] [--apply]`)
        process.exit(1)
    }
  } catch (e) { fatal(e.message) }

  if (flags.json === true || flags.json === undefined) {
    // human view by default only for ledger/docset ok results; JSON otherwise
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  if (out && out.ok === false) process.exit(1)
  if (out && out.problems && out.problems.length && cmd === 'ledger') process.exit(1)
}

if (import.meta.main) main()

export { parseMd, walkMd, resolveLink, simhash64, hamming, canon, sha256, docsetSha, validateDocset, parseLedger, VERSION }
