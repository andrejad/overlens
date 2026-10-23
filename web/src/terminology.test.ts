import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// REQ_OVR_010: the rows are workstreams, never "lane", "swimlane" or "track"; the bars are deliverables, never
// "epics". Scans code, schema, screens and docs of the whole repository (from web/, Vitest's working directory).
const root = resolve(process.cwd(), '..')
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report', 'graphify-out', 'wireframes', 'worktrees'])
const EXTS = new Set(['.go', '.ts', '.tsx', '.css', '.html', '.md', '.sql', '.json', '.conf', '.example', '.sh', '.yml', '.yaml'])
const WORD = /\b(lanes?|swimlanes?|tracks?|epics?)\b/i

// Files that define or discuss the rule itself (or its history), so they name the forbidden words.
const WHOLE_FILE = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  'docs/archive/EXECUTIVE-ROADMAPS-PROMPT.md',
  'requirements/REQ-OVR.md',
  '.claude/agents/docs.md',
  '.claude/agents/reviewer.md',
  'web/src/terminology.test.ts',
])
// Single lines allowed: the toggle switch's groove (Toolbar.tsx and its CSS), the text "Jira epic", tests feeding an
// unknown address kind to the trace route, and the README's plain-English "Jira tracks tasks" (REQ_OVR_010 allows it).
const ALLOWED_LINE: { file?: RegExp; line: RegExp }[] = [
  { file: /^web\/src\/components\/Toolbar\.tsx$/, line: /className="track"/ },
  { file: /^web\/src\/index\.css$/, line: /\.switch(\.on)? \.track\b/ },
  { line: /Jira epic/ },
  { file: /^README\.md$/, line: /Jira tracks tasks/ },
  { file: /^web\/(e2e\/12-milestone-dependencies\.spec|src\/lib\/companyView\.test)\.ts$/, line: /trace\/epic\// },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out)
    } else if (EXTS.has(name.slice(name.lastIndexOf('.'))) && name !== 'package-lock.json') out.push(p)
  }
  return out
}

describe('REQ_OVR_010 terminology', () => {
  it('REQ_OVR_010 no lane, swimlane, track or epic in code, schema, screens and docs (except the explicit allow-list)', () => {
    const offenders: string[] = []
    const files = walk(root)
    expect(files.length).toBeGreaterThan(50) // the scan really covered the repository
    for (const f of files) {
      const rel = relative(root, f).split(sep).join('/')
      if (WHOLE_FILE.has(rel) || rel.startsWith('docs/changelog/')) continue // the development log, history like the archived spec
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!WORD.test(line)) return
        if (ALLOWED_LINE.some((a) => (!a.file || a.file.test(rel)) && a.line.test(line))) return
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
