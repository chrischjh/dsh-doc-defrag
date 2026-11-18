# doc-defrag

English | [中文](README.md)

> AI writes documents every day. They pile up — **the current ones mixed with the stale ones** — and you want to clean up but don't know where to start. **This tool is built for exactly that.**

Moments you probably recognize:

- Last week's report and a three-month-old proposal describe the same thing, and you **don't know which one to trust**
- You **dare not delete**: the cost of deleting something important is far higher than keeping a pile of junk
- Ask the AI to "tidy up the docs" and it creates five more `SUMMARY.md` files
- A new teammate's (or a new agent's) first question is always: **which document do I read?**

This isn't a discipline problem. Fragmentation is produced faster than anyone can clean it up — and stale documents get read as ground truth by agents. They don't just take up space; **they poison every run**.

## What it does

In one sentence: **reads your docs → guesses the project type → gives you a default document set to choose → consolidates the valuable content into those few files → archives the rest (originals kept, indexed) → hands you a review card.**

**Archived ≠ dead**: `archive/index.md` tells you why each file is there and which new document absorbed its content. Everything stays retrievable.

## Usage

**One sentence is all you need:**

```
You: help me tidy up the project docs
```

## Why nothing gets lost

| Guarantee | How |
|---|---|
| **Never deletes** | Moves only. Originals go into `archive/` byte-for-byte, with their original relative paths |
| **Always reversible** | Snapshot + journal before touching any file; one-click restore that doesn't require git |

## Boundaries

- Markdown (`.md`) only; other formats are left alone
- Read-only by default; **it changes nothing until you approve**

## Install

```bash
dsh plugin add github:chrischjh/dsh-doc-defrag
dsh plugin add dsh-doc-defrag          # npm (after publish)
```

---

Full design in [DESIGN.md](DESIGN.md) (Chinese).
