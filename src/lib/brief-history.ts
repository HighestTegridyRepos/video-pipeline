import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { logInfo, logWarn } from "./logger"

const ROUTE = "brief-history"

// ── Types ────────────────────────────────────────────────────────

export interface BriefHistoryEntry {
  id: string
  timestamp: string
  brand: string
  niche: string
  platform: string
  tone?: string

  hookStatement: string
  concept: string
  viralScore: number
  viralReasoning: string
  sceneCount: number

  // Audit results
  imageScores: number[]           // per-scene audit scores
  avgImageScore: number
  finalVideoScore?: number        // final assembled video audit score
  finalVideoVerdict?: string

  // Outcomes — filled in later via feedback
  feedback?: "great" | "good" | "mid" | "bad"
  feedbackNote?: string
}

// ── File path ────────────────────────────────────────────────────

const HISTORY_DIR = join(process.cwd(), "data")
const HISTORY_FILE = join(HISTORY_DIR, "brief-history.json")
const MAX_ENTRIES = 100

// ── Read/write ───────────────────────────────────────────────────

export function loadHistory(): BriefHistoryEntry[] {
  try {
    if (!existsSync(HISTORY_FILE)) return []
    const raw = readFileSync(HISTORY_FILE, "utf-8")
    return JSON.parse(raw)
  } catch {
    logWarn(ROUTE, "Failed to load brief history, starting fresh")
    return []
  }
}

function saveHistory(entries: BriefHistoryEntry[]): void {
  try {
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2))
  } catch (err) {
    logWarn(ROUTE, `Failed to save brief history: ${(err as Error).message}`)
  }
}

// ── Public API ───────────────────────────────────────────────────

export function recordBrief(entry: BriefHistoryEntry): void {
  const entries = loadHistory()
  entries.push(entry)
  // Keep only the most recent entries
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  saveHistory(entries)
  logInfo(ROUTE, `Brief recorded: "${entry.hookStatement}" (score: ${entry.viralScore})`)
}

export function addFeedback(
  briefId: string,
  feedback: "great" | "good" | "mid" | "bad",
  note?: string,
): boolean {
  const entries = loadHistory()
  const entry = entries.find(e => e.id === briefId)
  if (!entry) return false
  entry.feedback = feedback
  entry.feedbackNote = note
  saveHistory(entries)
  logInfo(ROUTE, `Feedback added for "${entry.hookStatement}": ${feedback}`)
  return true
}

export function updateVideoScore(
  briefId: string,
  score: number,
  verdict: string,
): void {
  const entries = loadHistory()
  const entry = entries.find(e => e.id === briefId)
  if (!entry) return
  entry.finalVideoScore = score
  entry.finalVideoVerdict = verdict
  saveHistory(entries)
}

/**
 * Build a learning context string for the idea generator.
 * Includes recent briefs with their outcomes so the model
 * can learn what works and what doesn't.
 */
export function buildLearningContext(): string {
  const entries = loadHistory()
  if (entries.length === 0) return ""

  // Get the last 10 entries with feedback or high scores
  const relevant = entries
    .slice(-20)
    .filter(e => e.feedback || e.viralScore >= 8 || (e.finalVideoScore && e.finalVideoScore >= 7))

  if (relevant.length === 0) {
    // No feedback yet — just show recent concepts to avoid repetition
    const recent = entries.slice(-5)
    const recentConcepts = recent.map(e => `- "${e.hookStatement}" (score: ${e.viralScore})`).join("\n")
    return `\nRECENT CONCEPTS (avoid repeating these):\n${recentConcepts}\n`
  }

  const lines: string[] = []

  // What worked
  const great = relevant.filter(e => e.feedback === "great" || (e.feedback === "good" && e.viralScore >= 8))
  if (great.length > 0) {
    lines.push("WHAT WORKED WELL (do more like this):")
    for (const e of great.slice(-3)) {
      lines.push(`- "${e.hookStatement}" — score ${e.viralScore}, feedback: ${e.feedback}${e.feedbackNote ? ` (${e.feedbackNote})` : ""}`)
    }
  }

  // What didn't work
  const bad = relevant.filter(e => e.feedback === "bad" || e.feedback === "mid")
  if (bad.length > 0) {
    lines.push("WHAT DIDN'T WORK (avoid these patterns):")
    for (const e of bad.slice(-3)) {
      lines.push(`- "${e.hookStatement}" — score ${e.viralScore}, feedback: ${e.feedback}${e.feedbackNote ? ` (${e.feedbackNote})` : ""}`)
    }
  }

  // Recent concepts to avoid repetition
  const recent = entries.slice(-5)
  lines.push("RECENT CONCEPTS (don't repeat):")
  for (const e of recent) {
    lines.push(`- "${e.hookStatement}"`)
  }

  return "\n" + lines.join("\n") + "\n"
}
