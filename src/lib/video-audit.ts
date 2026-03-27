import { getGeminiClient } from "./gemini"
import { logInfo, logWarn } from "./logger"
import { execSync } from "child_process"
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { v4 as uuid } from "uuid"

const ROUTE = "video-audit"

// ── Types ────────────────────────────────────────────────────────

export interface VideoAuditResult {
  pass: boolean
  score: number           // 1-10
  hookScore: number       // 1-10 — how strong is the first 1-2s?
  coherenceScore: number  // 1-10 — do scenes flow together?
  qualityScore: number    // 1-10 — visual quality, artifacts?
  musicSync: number       // 1-10 — does music feel matched? (from frames alone, limited)
  issues: string[]
  verdict: string
}

// ── System prompt ────────────────────────────────────────────────

const AUDIT_SYSTEM_PROMPT = `You are a quality auditor for AI-generated video reels for social media advertising.
You will be shown 4-6 frames extracted from a short video reel (30-60s, 9:16 vertical).

AUDIT CHECKLIST:
1. Hook Quality — Does frame 1 (the opening) grab attention? Is it a strong pattern interrupt?
2. Visual Coherence — Do the frames look like they belong in the same video? Consistent style/mood?
3. Technical Quality — Are frames sharp, well-composed, free of artifacts/distortion?
4. Narrative Arc — Do the frames suggest a progression (hook → build → payoff)?
5. Brand Alignment — Does this look like premium content from an AI creative tools studio?

SCORING:
- hookScore: 1-10 — strength of the opening frame as a hook
- coherenceScore: 1-10 — visual consistency across frames
- qualityScore: 1-10 — technical image quality
- musicSync: 1-10 — inferred from visual pacing (limited, score 5-7 if unsure)
- score: 1-10 — overall verdict
- pass: true if score >= 6

Return JSON only:
{
  "pass": true/false,
  "score": 1-10,
  "hookScore": 1-10,
  "coherenceScore": 1-10,
  "qualityScore": 1-10,
  "musicSync": 1-10,
  "issues": ["list of specific issues"],
  "verdict": "one sentence assessment"
}`

// ── Frame extraction ─────────────────────────────────────────────

function extractFrames(videoDataUrl: string, count: number = 5): string[] {
  const tmpDir = join("/tmp", `video-audit-${uuid()}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    // Write video to temp file
    const match = videoDataUrl.match(/^data:[^;]+;base64,(.+)$/)
    if (!match) throw new Error("Invalid video data URL")

    const videoPath = join(tmpDir, "input.mp4")
    writeFileSync(videoPath, Buffer.from(match[1], "base64"))

    // Get duration
    const durStr = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}" 2>/dev/null`
    ).toString().trim()
    const duration = parseFloat(durStr) || 10

    // Extract frames at evenly spaced intervals
    // Always get the first frame (hook), then spread the rest
    const frames: string[] = []
    const intervals = [0] // First frame is always at t=0
    for (let i = 1; i < count; i++) {
      intervals.push((duration * i) / (count - 1))
    }

    for (let i = 0; i < intervals.length; i++) {
      const framePath = join(tmpDir, `frame_${i}.jpg`)
      try {
        execSync(
          `ffmpeg -y -ss ${intervals[i].toFixed(2)} -i "${videoPath}" -vframes 1 -q:v 2 "${framePath}" 2>/dev/null`,
          { timeout: 10000 }
        )
        if (existsSync(framePath)) {
          const frameData = readFileSync(framePath)
          frames.push(frameData.toString("base64"))
        }
      } catch {
        // Skip frame if extraction fails
      }
    }

    return frames
  } finally {
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* */ }
  }
}

// ── Main function ────────────────────────────────────────────────

export async function auditVideo(
  videoDataUrl: string,
  concept?: string,
): Promise<VideoAuditResult> {
  logInfo(ROUTE, "Extracting frames for video audit...")

  const frames = extractFrames(videoDataUrl, 5)
  if (frames.length === 0) {
    logWarn(ROUTE, "Could not extract any frames, skipping audit")
    return {
      pass: true, score: 5, hookScore: 5, coherenceScore: 5,
      qualityScore: 5, musicSync: 5,
      issues: ["frame extraction failed"],
      verdict: "Could not extract frames — passing by default",
    }
  }

  logInfo(ROUTE, `Extracted ${frames.length} frames, sending to vision model...`)

  const ai = getGeminiClient()

  const userPrompt = `Audit this video reel for social media quality.
${concept ? `\nConcept: ${concept}` : ""}
${frames.length} frames extracted at even intervals from the video. Frame 1 is the opening hook.

Return JSON only.`

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: userPrompt },
  ]

  for (let i = 0; i < frames.length; i++) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: frames[i],
      },
    })
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts }],
      config: { systemInstruction: AUDIT_SYSTEM_PROMPT },
    })

    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text
    if (!rawText) {
      logWarn(ROUTE, "Video audit returned no response")
      return {
        pass: true, score: 5, hookScore: 5, coherenceScore: 5,
        qualityScore: 5, musicSync: 5,
        issues: ["audit unavailable"],
        verdict: "Audit returned no response — passing by default",
      }
    }

    const start = rawText.indexOf("{")
    const end = rawText.lastIndexOf("}")
    if (start === -1 || end === -1) throw new Error("No JSON")

    const result: VideoAuditResult = JSON.parse(rawText.slice(start, end + 1))

    // Normalize pass based on score
    result.pass = result.score >= 6

    const status = result.pass ? "✓" : "✗"
    logInfo(ROUTE, `Video audit ${status}: ${result.score}/10 — ${result.verdict}`)
    logInfo(ROUTE, `  Hook: ${result.hookScore}/10, Coherence: ${result.coherenceScore}/10, Quality: ${result.qualityScore}/10`)

    return result
  } catch (err) {
    logWarn(ROUTE, `Video audit failed: ${(err as Error).message}`)
    return {
      pass: true, score: 5, hookScore: 5, coherenceScore: 5,
      qualityScore: 5, musicSync: 5,
      issues: ["audit error"],
      verdict: `Audit failed: ${(err as Error).message} — passing by default`,
    }
  }
}
