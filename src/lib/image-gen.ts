import { getGeminiClient, IMAGE_MODEL, NANO_BANANA_2 } from "./gemini"
import { logInfo, logWarn } from "./logger"

const ROUTE = "image-gen"

// ── Types ────────────────────────────────────────────────────────

export interface ImageGenResult {
  imageDataUrl: string
  mimeType: string
  model: string
  prompt: string
}

export interface ImageAuditResult {
  pass: boolean
  score: number
  issues: string[]
  verdict: string
}

export interface ImageGenWithAuditResult extends ImageGenResult {
  auditResult?: ImageAuditResult
  retried?: boolean
}

// ── Image audit ──────────────────────────────────────────────────

const AUDIT_SYSTEM_PROMPT = `You are a quality auditor for AI-generated visual content for advertising and social media.
You will be shown an image and must audit it for use as a HERO FRAME in a 9:16 vertical video ad/reel.

AUDIT CHECKLIST:
1. Composition — Is the main subject well-framed? No awkward crops? Follows rule of thirds or has intentional asymmetry?
2. Sharpness — Is the image crisp and cinematic? No blurriness or digital artifacts?
3. Aspect Ratio — Is it portrait (taller than wide) or has composition that works well in 9:16?
4. Text — Is there any text in the image? If yes, FAIL (we add text separately). If no, pass.
5. Brand Alignment — Does it match the concept/prompt provided?
6. Artifact Detection — Any watermarks, logos, visible seams, distorted hands/faces? Flag them.
7. Overall Usability — Would you use this as the hero image for a paid ad/reel?

Scoring:
- 9-10: Excellent. Ship it.
- 7-8: Good. Use it.
- 5-6: Okay. Use if deadline pressure, but not ideal.
- 3-4: Weak. Consider retry.
- 1-2: Fail. Definitely retry.

Return JSON only:
{
  "pass": true/false,
  "score": 1-10,
  "issues": ["list of specific issues found"],
  "verdict": "one sentence assessment"
}`

export async function auditImage(
  imageBase64: string,
  mimeType: string,
  originalPrompt: string,
  aspectRatio?: string,
): Promise<ImageAuditResult> {
  const ai = getGeminiClient()

  const userPrompt = `Audit this image generated for use in a video reel.

Original prompt: ${originalPrompt}
Aspect ratio: ${aspectRatio || "9:16"}

Return JSON only.`

  logInfo(ROUTE, "Auditing image quality...")

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: userPrompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    config: {
      systemInstruction: AUDIT_SYSTEM_PROMPT,
    },
  })

  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) {
    logWarn(ROUTE, "Audit returned no response, defaulting to pass")
    return { pass: true, score: 5, issues: ["audit unavailable"], verdict: "Audit returned no response — passing by default" }
  }

  try {
    const start = rawText.indexOf("{")
    const end = rawText.lastIndexOf("}")
    if (start === -1 || end === -1) throw new Error("No JSON in audit response")
    const result: ImageAuditResult = JSON.parse(rawText.slice(start, end + 1))

    // Ensure pass is based on score if not set correctly
    if (result.score >= 6) result.pass = true
    else result.pass = false

    return result
  } catch {
    logWarn(ROUTE, `Audit JSON parse failed: ${rawText.slice(0, 200)}`)
    return { pass: true, score: 5, issues: ["audit parse failed"], verdict: "Could not parse audit — passing by default" }
  }
}

// ── Image generation with optional audit ─────────────────────────

/**
 * Generate an image using Nano Banana Pro (or specified model).
 * Optionally audits the image and retries if it fails.
 */
export async function generateImage(
  prompt: string,
  options?: {
    model?: string
    audit?: boolean
    auditAspectRatio?: string
    maxRetries?: number
  },
): Promise<ImageGenWithAuditResult> {
  const activeModel = options?.model || IMAGE_MODEL
  const ai = getGeminiClient()

  logInfo(ROUTE, `Generating image with ${activeModel}`, { promptLength: prompt.length })

  const response = await ai.models.generateContent({
    model: activeModel,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseModalities: ["IMAGE", "TEXT"] as unknown as undefined },
  })

  const parts = response.candidates?.[0]?.content?.parts
  if (!parts) {
    throw new Error("Image generation returned no response")
  }

  let imageBase64: string | null = null
  let imageMimeType = "image/png"
  for (const part of parts) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data ?? null
      imageMimeType = part.inlineData.mimeType ?? "image/png"
      break
    }
  }

  if (!imageBase64) {
    throw new Error("Image model did not return an image")
  }

  logInfo(ROUTE, `Image generated successfully`)

  const result: ImageGenWithAuditResult = {
    imageDataUrl: `data:${imageMimeType};base64,${imageBase64}`,
    mimeType: imageMimeType,
    model: activeModel,
    prompt,
  }

  // Skip audit if not requested
  if (options?.audit === false || !options?.audit) {
    return result
  }

  // Audit the image
  const auditResult = await auditImage(imageBase64, imageMimeType, prompt, options.auditAspectRatio)
  result.auditResult = auditResult

  if (auditResult.pass) {
    logInfo(ROUTE, `Image audit passed: ${auditResult.score}/10 — ${auditResult.verdict}`)
    return result
  }

  // Audit failed — retry if allowed
  const maxRetries = options.maxRetries ?? 1
  if (maxRetries > 0) {
    logWarn(ROUTE, `Image audit failed (${auditResult.score}/10): ${auditResult.issues.join(", ")}. Retrying with improved prompt...`)
    const retryPrompt = `${prompt}. (Retry: avoid ${auditResult.issues.join(", ")})`
    const retryResult = await generateImage(retryPrompt, {
      model: options.model,
      audit: true,
      auditAspectRatio: options.auditAspectRatio,
      maxRetries: maxRetries - 1,
    })
    retryResult.retried = true
    return retryResult
  }

  // Max retries exhausted — return best attempt anyway
  logWarn(ROUTE, `Image audit failed after retries (${auditResult.score}/10), using best attempt`)
  return result
}

/**
 * Generate multiple images in parallel. Returns successful results.
 */
export async function generateImages(
  prompts: string[],
  model?: string,
): Promise<ImageGenResult[]> {
  const results = await Promise.allSettled(
    prompts.map(prompt => generateImage(prompt, { model }))
  )

  const images: ImageGenResult[] = []
  for (const result of results) {
    if (result.status === "fulfilled") {
      images.push(result.value)
    } else {
      logWarn(ROUTE, `Image generation failed: ${result.reason}`)
    }
  }

  return images
}
