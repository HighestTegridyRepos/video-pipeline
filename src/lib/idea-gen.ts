import { getGeminiClient, GEMINI_FLASH } from "./gemini"
import { logInfo, logWarn } from "./logger"

const ROUTE = "idea-gen"

// ── Types ────────────────────────────────────────────────────────

export interface IdeaGenInput {
  brand: string
  niche: string
  platform: "instagram" | "tiktok" | "youtube"
  format: "reel" | "short" | "video"
  tone?: string
  avoid?: string[]
  count?: number
}

export interface ContentBrief {
  hookStatement: string
  viralReasoning: string

  concept: string
  captionHook: string

  scenes: Array<{
    sceneNumber: number
    imagePrompt: string
    animationPrompt: string
    duration: number
    purpose: string
  }>

  music: {
    prompt: string
    bpm: number
    mood: string
    vocals: boolean
    vocalStyle?: string
    vocalLyrics?: string
  }

  hashtags: string[]
  viralScore: number
  viralScoreReasoning: string

  alternatives?: ContentBrief[]

  // Error case
  error?: string
  reason?: string
}

// ── System prompt ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a world-class viral content strategist with 10+ years studying viral videos across platforms.

Your job: Generate content briefs for @ghostkey.studio (AI creative tools studio) that have GENUINE viral potential.

VIRAL PATTERNS YOU MUST UNDERSTAND:
- Pattern interrupt (something unexpected in first 0.5s)
- Aesthetic density (looks incredible + feels premium)
- Relatable tension → satisfying resolution
- "Forbidden knowledge" (feels exclusive or revelatory)
- Technical flex (makes viewer think "how did they make this?")
- Aspirational but achievable (viewer thinks "I could do this")

SCORING CRITERIA (HONEST):
- 9-10: Taps a proven pattern AND novel execution. Will get shares.
- 7-8: Strong hook, format perfect, good originality. Likely to perform.
- 5-6: Competent, fits the brand, but generic. Noise.
- 1-4: Skip entirely. Don't propose it.

CONSTRAINTS:
- Must be 30-60s format (9:16 vertical)
- Max 2-3 scenes (production time)
- No talking heads or tutorials (ghostkey is about aesthetics + tools, not education)
- No heavy text overlays (visuals first)
- Music is CRITICAL — match tone to visuals

RESPONSE FORMAT: Return ONLY valid JSON with EXACTLY these field names (camelCase). No markdown, no explanation.

{
  "hookStatement": "one-liner core idea",
  "viralReasoning": "3-4 sentences: WHAT viral pattern + WHY it works",
  "concept": "full concept description",
  "captionHook": "first 1-2 lines of IG caption",
  "scenes": [
    {
      "sceneNumber": 1,
      "imagePrompt": "detailed image generation prompt",
      "animationPrompt": "video animation direction",
      "duration": 5,
      "purpose": "hook/build/payoff/CTA"
    }
  ],
  "music": {
    "prompt": "specific music prompt with mood and instrumentation",
    "bpm": 110,
    "mood": "dark ambient",
    "vocals": false,
    "vocalStyle": "optional if vocals true",
    "vocalLyrics": "optional if vocals true"
  },
  "hashtags": ["tag1", "tag2"],
  "viralScore": 8,
  "viralScoreReasoning": "why this score"
}

If you cannot generate a brief scoring 7+, return { "error": "Could not generate brief above score 6", "reason": "explanation" }`

// ── JSON extraction ──────────────────────────────────────────────

function extractJson(text: string): string {
  // Try to find JSON object boundaries
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in response")
  }
  return text.slice(start, end + 1)
}

function validateBrief(brief: ContentBrief): string[] {
  const missing: string[] = []
  if (!brief.hookStatement) missing.push("hookStatement")
  if (!brief.concept) missing.push("concept")
  if (!brief.scenes || !Array.isArray(brief.scenes) || brief.scenes.length === 0) missing.push("scenes")
  if (!brief.music) missing.push("music")
  if (brief.viralScore == null) missing.push("viralScore")
  return missing
}

// ── Main function ────────────────────────────────────────────────

export async function generateIdea(input: IdeaGenInput): Promise<ContentBrief> {
  const ai = getGeminiClient()

  const userPrompt = `Generate a viral reel brief for this brand:

Brand: ${input.brand}
Niche: ${input.niche}
Platform: ${input.platform}
Format: ${input.format}
Tone: ${input.tone || "cinematic professional"}
Avoid: ${input.avoid?.join(", ") || "none"}

Return ONE content brief with the highest viral potential. JSON only.
${input.count && input.count > 1 ? `Also include alternatives array with ${input.count - 1} alternative briefs.` : ""}`

  logInfo(ROUTE, `Generating idea for ${input.brand}`, {
    platform: input.platform,
    format: input.format,
    tone: input.tone,
  })

  let rawText: string | undefined
  let retryCount = 0
  const maxRetries = 1

  while (retryCount <= maxRetries) {
    const response = await ai.models.generateContent({
      model: GEMINI_FLASH,
      contents: [
        { role: "user", parts: [{ text: retryCount === 0 ? userPrompt : `${userPrompt}\n\nIMPORTANT: Return ONLY valid JSON. No markdown code fences. No text before or after the JSON object.` }] },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
      },
    })

    rawText = response.candidates?.[0]?.content?.parts?.[0]?.text
    if (!rawText) {
      throw new Error("Idea generation returned no response")
    }

    try {
      const jsonStr = extractJson(rawText)
      const brief: ContentBrief = JSON.parse(jsonStr)

      // Check for error response from the model
      if (brief.error) {
        logWarn(ROUTE, `Model returned error: ${brief.error} — ${brief.reason}`)
        return brief
      }

      // Validate required fields
      const missing = validateBrief(brief)
      if (missing.length > 0) {
        if (retryCount < maxRetries) {
          logWarn(ROUTE, `Brief missing fields: ${missing.join(", ")}. Retrying...`)
          retryCount++
          continue
        }
        throw new Error(`Idea generation failed: brief missing fields: ${missing.join(", ")}`)
      }

      if (brief.viralScore < 7) {
        logWarn(ROUTE, `Brief viral score is ${brief.viralScore}/10 (below 7 threshold)`)
      }

      logInfo(ROUTE, `Idea generated: "${brief.hookStatement}" (score: ${brief.viralScore}/10)`)
      return brief
    } catch (err) {
      if (err instanceof SyntaxError) {
        if (retryCount < maxRetries) {
          logWarn(ROUTE, `JSON parse failed, retrying with clearer instructions...`)
          retryCount++
          continue
        }
        logWarn(ROUTE, `Raw response that failed to parse: ${rawText.slice(0, 500)}`)
        throw new Error("Idea generation failed: could not parse JSON")
      }
      throw err
    }
  }

  throw new Error("Idea generation failed: exhausted retries")
}
