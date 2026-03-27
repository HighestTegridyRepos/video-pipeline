import { generateImage, auditImage, ImageAuditResult, ImageGenWithAuditResult } from "./image-gen"
import { logInfo, logWarn } from "./logger"

const ROUTE = "image-selection"

const MIN_SCENES = 3
const QUALITY_THRESHOLD = 7  // audit score >= 7 = "good"

// ── Types ────────────────────────────────────────────────────────

interface SceneCandidate {
  sceneNumber: number
  imagePrompt: string
  animationPrompt: string
  duration: number
  purpose: string
  imageDataUrl?: string     // pre-provided by caller
}

export interface SelectedScene {
  sceneNumber: number
  imagePrompt: string
  animationPrompt: string
  duration: number
  purpose: string
  imageDataUrl: string
  auditResult: ImageAuditResult
  wasRetried: boolean
}

export interface SelectionResult {
  selected: SelectedScene[]
  dropped: Array<{ sceneNumber: number; reason: string; auditScore?: number }>
  totalGenerated: number
  totalRetried: number
}

// ── Main function ────────────────────────────────────────────────

/**
 * Generate images for all scenes, audit them, select the best ones.
 *
 * Flow:
 * 1. Generate images for all scenes in parallel
 * 2. Audit all generated images in parallel
 * 3. Sort by audit score
 * 4. If fewer than MIN_SCENES pass quality threshold, regenerate the worst
 * 5. Return the best 3-5 scenes (minimum 3)
 */
export async function selectBestScenes(
  scenes: SceneCandidate[],
  options: {
    aspectRatio?: string
    orientationSuffix?: string
  } = {},
): Promise<SelectionResult> {
  const aspectRatio = options.aspectRatio || "9:16"
  const orientationSuffix = options.orientationSuffix || ""

  logInfo(ROUTE, `Generating and auditing ${scenes.length} scene images...`)

  // ── Step 1: Generate all images in parallel ──────────────────
  type SceneWithImage = {
    scene: SceneCandidate
    image: ImageGenWithAuditResult | null
    error?: string
  }

  const genResults: SceneWithImage[] = await Promise.all(
    scenes.map(async (scene): Promise<SceneWithImage> => {
      // Skip generation if image already provided
      if (scene.imageDataUrl) {
        return { scene, image: null }
      }

      try {
        const orientedPrompt = scene.imagePrompt + orientationSuffix
        const result = await generateImage(orientedPrompt, {
          audit: false, // We'll batch-audit separately
        })
        return { scene, image: result }
      } catch (err) {
        logWarn(ROUTE, `Scene ${scene.sceneNumber} image gen failed: ${(err as Error).message}`)
        return { scene, image: null, error: (err as Error).message }
      }
    })
  )

  // ── Step 2: Audit all generated images in parallel ───────────
  type AuditedScene = {
    scene: SceneCandidate
    imageDataUrl: string
    mimeType: string
    audit: ImageAuditResult
    wasRetried: boolean
  }

  const auditPromises = genResults.map(async (gr): Promise<AuditedScene | null> => {
    // Pre-provided images pass automatically
    if (gr.scene.imageDataUrl) {
      return {
        scene: gr.scene,
        imageDataUrl: gr.scene.imageDataUrl,
        mimeType: "image/png",
        audit: { pass: true, score: 10, issues: [], verdict: "User-provided image" },
        wasRetried: false,
      }
    }

    if (!gr.image) return null  // Generation failed

    // Extract base64 for audit
    const match = gr.image.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null

    const audit = await auditImage(match[2], match[1], gr.scene.imagePrompt, aspectRatio)

    return {
      scene: gr.scene,
      imageDataUrl: gr.image.imageDataUrl,
      mimeType: gr.image.mimeType,
      audit,
      wasRetried: false,
    }
  })

  const audited = (await Promise.all(auditPromises)).filter((a): a is AuditedScene => a !== null)

  // Log audit results
  for (const a of audited) {
    const status = a.audit.pass ? "✓" : "✗"
    logInfo(ROUTE, `Scene ${a.scene.sceneNumber} ${status}: ${a.audit.score}/10 — ${a.audit.verdict}`)
  }

  // ── Step 3: Sort by score and check if we have enough ────────
  audited.sort((a, b) => b.audit.score - a.audit.score)

  const passing = audited.filter(a => a.audit.score >= QUALITY_THRESHOLD)
  const failing = audited.filter(a => a.audit.score < QUALITY_THRESHOLD)

  logInfo(ROUTE, `Audit summary: ${passing.length} passing (>=${QUALITY_THRESHOLD}), ${failing.length} below threshold`)

  // ── Step 4: Regenerate if too few pass ───────────────────────
  let totalRetried = 0

  if (passing.length < MIN_SCENES && failing.length > 0) {
    const needed = MIN_SCENES - passing.length
    const toRetry = failing.slice(0, needed)

    logInfo(ROUTE, `Need ${needed} more good images. Retrying ${toRetry.length} scenes with improved prompts...`)

    const retryResults = await Promise.all(
      toRetry.map(async (f): Promise<AuditedScene | null> => {
        totalRetried++
        const retryPrompt = `${f.scene.imagePrompt}${orientationSuffix}. (Improved: avoid ${f.audit.issues.join(", ")}. High quality, crisp, cinematic.)`

        try {
          const result = await generateImage(retryPrompt, { audit: false })
          const match = result.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/)
          if (!match) return null

          const audit = await auditImage(match[2], match[1], f.scene.imagePrompt, aspectRatio)
          logInfo(ROUTE, `Scene ${f.scene.sceneNumber} retry: ${audit.score}/10 (was ${f.audit.score}/10)`)

          // Use the better of the two
          if (audit.score > f.audit.score) {
            return {
              scene: f.scene,
              imageDataUrl: result.imageDataUrl,
              mimeType: result.mimeType,
              audit,
              wasRetried: true,
            }
          } else {
            return { ...f, wasRetried: true }
          }
        } catch (err) {
          logWarn(ROUTE, `Scene ${f.scene.sceneNumber} retry failed: ${(err as Error).message}`)
          return f  // Keep original
        }
      })
    )

    // Replace failing entries with retry results
    for (const retryResult of retryResults) {
      if (!retryResult) continue
      const idx = audited.findIndex(a => a.scene.sceneNumber === retryResult.scene.sceneNumber)
      if (idx !== -1) audited[idx] = retryResult
    }

    // Re-sort after retries
    audited.sort((a, b) => b.audit.score - a.audit.score)
  }

  // ── Step 5: Select the best scenes ───────────────────────────
  // Take all that pass, minimum 3 (use best available even if below threshold)
  const selected: SelectedScene[] = []
  const dropped: SelectionResult["dropped"] = []

  // First pass: take all passing scenes
  for (const a of audited) {
    if (a.audit.score >= QUALITY_THRESHOLD || selected.length < MIN_SCENES) {
      selected.push({
        sceneNumber: a.scene.sceneNumber,
        imagePrompt: a.scene.imagePrompt,
        animationPrompt: a.scene.animationPrompt,
        duration: a.scene.duration,
        purpose: a.scene.purpose,
        imageDataUrl: a.imageDataUrl,
        auditResult: a.audit,
        wasRetried: a.wasRetried,
      })
    } else {
      dropped.push({
        sceneNumber: a.scene.sceneNumber,
        reason: `Below threshold (${a.audit.score}/10)`,
        auditScore: a.audit.score,
      })
    }
  }

  // Also drop any scenes that completely failed generation
  for (const gr of genResults) {
    if (gr.error && !gr.scene.imageDataUrl) {
      dropped.push({
        sceneNumber: gr.scene.sceneNumber,
        reason: `Generation failed: ${gr.error}`,
      })
    }
  }

  // Sort selected back to scene order for narrative coherence
  selected.sort((a, b) => a.sceneNumber - b.sceneNumber)

  logInfo(ROUTE, `Selection complete: ${selected.length} scenes selected, ${dropped.length} dropped, ${totalRetried} retried`)

  return {
    selected,
    dropped,
    totalGenerated: genResults.filter(g => g.image || g.scene.imageDataUrl).length,
    totalRetried,
  }
}
