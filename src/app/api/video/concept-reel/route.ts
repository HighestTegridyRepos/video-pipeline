import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { generateVideo } from "@/lib/video-gen"
import { generateMusic } from "@/lib/music-gen"
import { generateIdea, ContentBrief } from "@/lib/idea-gen"
import { selectBestScenes, SelectedScene } from "@/lib/image-selection"
import { auditVideo, VideoAuditResult } from "@/lib/video-audit"
import { recordBrief, updateVideoScore } from "@/lib/brief-history"
import { assembleVideo, TextOverlay, Watermark } from "@/lib/assembly"
import { logInfo, logWarn } from "@/lib/logger"
import { ImageAuditResult } from "@/lib/image-gen"
import { v4 as uuid } from "uuid"

const ROUTE = "api/video/concept-reel"

// Full pipeline can take several minutes
export const maxDuration = 300

// ── Cost tracking ─────────────────────────────────────────────────

const IMAGE_COST = 0.00  // effectively free
const VIDEO_COST: Record<string, number> = {
  "veo-3.1-generate-preview": 1.60,
  "veo-3.1-fast-generate-preview": 0.80,
}
const MUSIC_COST = 0.00  // effectively free

// ── Types ─────────────────────────────────────────────────────────

interface SceneInput {
  sceneNumber?: number
  imagePrompt: string
  animationPrompt: string
  duration?: number         // 4-8, default 4
  purpose?: string
  imageDataUrl?: string     // skip image gen if provided
}

interface MusicInput {
  prompt: string
  duration?: number
  bpm?: number
  instrumental?: boolean
  vocals?: boolean
  mood?: string
  vocalStyle?: string
  vocalLyrics?: string
  musicDataUrl?: string
}

interface AssemblyInput {
  aspectRatio?: string
  targetDuration?: number
  cutStyle?: "fast" | "full"
  resolution?: string
  fps?: number
  textOverlays?: TextOverlay[]
  watermark?: Watermark
  musicFadeIn?: number
  musicFadeOut?: number
}

interface ConceptReelRequest {
  concept?: string
  scenes?: SceneInput[]
  brand?: string
  niche?: string
  platform?: string
  format?: string
  tone?: string
  avoid?: string[]
  music?: MusicInput
  assembly?: AssemblyInput
  videoModel?: string
}

interface SceneResult {
  sceneNumber: number
  imageDataUrl: string
  videoDataUrl: string
  originalDuration: number
  trimmedDuration: number | null
  imagePrompt: string
  animationPrompt: string
  purpose: string
  auditResult?: ImageAuditResult
}

// ── Main handler ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const reelId = uuid()
  logInfo(ROUTE, `Concept reel request received (id: ${reelId})`)

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // ── Idea generation (if no scenes provided) ─────────────────────
  let requestConcept: string | undefined = body.concept
  let requestScenes: SceneInput[] | undefined = body.scenes
  let requestBrief: ContentBrief | undefined

  if (!requestScenes || !Array.isArray(requestScenes) || requestScenes.length === 0) {
    if (!body.brand || !body.niche) {
      return NextResponse.json(
        { error: "Either (concept + scenes) OR (brand + niche + platform + format) required" },
        { status: 400 }
      )
    }

    logInfo(ROUTE, "Generating idea from brand/niche...")
    try {
      const brief = await generateIdea({
        brand: body.brand,
        niche: body.niche,
        platform: body.platform || "instagram",
        format: body.format || "reel",
        tone: body.tone,
        avoid: body.avoid,
      })

      if (brief.error) {
        return NextResponse.json(
          { error: `Idea generation failed: ${brief.reason}` },
          { status: 400 }
        )
      }

      requestBrief = brief
      requestConcept = brief.concept
      requestScenes = brief.scenes

      if (!body.music) {
        body.music = brief.music
      }

      logInfo(ROUTE, `Brief generated: "${brief.hookStatement}" (score: ${brief.viralScore}, scenes: ${brief.scenes.length})`)
    } catch (err) {
      logWarn(ROUTE, `Idea generation failed: ${(err as Error).message}`)
      return NextResponse.json(
        { error: `Idea generation failed: ${(err as Error).message}` },
        { status: 502 }
      )
    }
  }

  const concept = requestConcept
  const scenes = requestScenes!
  const music: MusicInput | undefined = body.music
  const assembly: AssemblyInput = body.assembly || {}
  const videoModel: string | undefined = body.videoModel

  if (!concept || typeof concept !== "string") {
    return NextResponse.json({ error: "concept (string) is required" }, { status: 400 })
  }

  if (scenes.length > 8) {
    return NextResponse.json({ error: "Max 8 scenes per concept reel" }, { status: 400 })
  }

  const costs = { images: 0, videos: 0, music: 0, total: 0 }

  try {
    // ── STEP 1: Generate + audit + select best images ───────────
    const aspectRatio = assembly.aspectRatio || "9:16"

    let orientationSuffix = ""
    if (aspectRatio === "9:16") {
      orientationSuffix = " Portrait orientation, vertical composition, taller than wide, 9:16 aspect ratio."
    } else if (aspectRatio === "16:9") {
      orientationSuffix = " Landscape orientation, horizontal composition, wider than tall, 16:9 aspect ratio."
    } else if (aspectRatio === "1:1") {
      orientationSuffix = " Square composition, 1:1 aspect ratio."
    }

    logInfo(ROUTE, `Step 1: Generating and selecting best images from ${scenes.length} scenes`)

    const selection = await selectBestScenes(
      scenes.map((s, i) => ({
        sceneNumber: s.sceneNumber ?? i + 1,
        imagePrompt: s.imagePrompt,
        animationPrompt: s.animationPrompt,
        duration: s.duration || 4,
        purpose: s.purpose || "scene",
        imageDataUrl: s.imageDataUrl,
      })),
      { aspectRatio, orientationSuffix },
    )

    costs.images += selection.totalGenerated * IMAGE_COST

    if (selection.selected.length === 0) {
      return NextResponse.json({ error: "All image generations failed" }, { status: 502 })
    }

    if (selection.dropped.length > 0) {
      logInfo(ROUTE, `Dropped ${selection.dropped.length} scenes: ${selection.dropped.map(d => `#${d.sceneNumber} (${d.reason})`).join(", ")}`)
    }

    logInfo(ROUTE, `Step 1 done: ${selection.selected.length} scenes selected (${selection.totalRetried} retried)`)

    // ── STEP 2: Generate videos + music (parallel) ───────────────
    logInfo(ROUTE, "Step 2: Generating videos and music in parallel")

    const selectedScenes = selection.selected

    // Video generation promises
    const videoPromises = selectedScenes.map(async (scene) => {
      const duration = Math.min(Math.max(Math.round(scene.duration), 4), 8)

      const match = scene.imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
      if (!match) throw new Error(`Invalid image data URL for scene ${scene.sceneNumber}`)

      const result = await generateVideo(scene.animationPrompt, {
        imageBase64: match[2],
        imageMimeType: match[1],
        duration,
        aspectRatio,
        model: videoModel,
      })

      const activeModel = videoModel || "veo-3.1-generate-preview"
      costs.videos += VIDEO_COST[activeModel] || 1.60

      return {
        sceneNumber: scene.sceneNumber,
        imageDataUrl: scene.imageDataUrl,
        videoDataUrl: result.videoDataUrl,
        originalDuration: duration,
        imagePrompt: scene.imagePrompt,
        animationPrompt: scene.animationPrompt,
        purpose: scene.purpose,
        auditResult: scene.auditResult,
      }
    })

    // Music generation promise (parallel with videos)
    let musicDataUrl: string | null = null
    const musicPromise = (async () => {
      if (music?.musicDataUrl) {
        logInfo(ROUTE, "Using provided music, skipping generation")
        return music.musicDataUrl
      }

      const musicPrompt = music?.prompt || `${concept}. Cinematic, emotional, dynamic.`
      const musicVocals = music?.vocals ?? false
      const musicDuration = music?.duration || 20
      const musicBpm = music?.bpm || 110

      try {
        logInfo(ROUTE, `Generating music (vocals: ${musicVocals}, bpm: ${musicBpm})...`)
        const result = await generateMusic(
          musicVocals ? musicPrompt : `${musicPrompt}. Instrumental only, no vocals.`,
          {
            duration: musicDuration,
            bpm: musicBpm,
            instrumental: !musicVocals,
            vocals: musicVocals,
          }
        )
        costs.music += MUSIC_COST
        logInfo(ROUTE, `Music generated: ${result.duration}s, model: ${result.model}`)
        return result.audioDataUrl
      } catch (err) {
        logWarn(ROUTE, `Music generation failed: ${(err as Error).message}`)
        return null
      }
    })()

    // Wait for all videos and music
    const [videoResults, musicResult] = await Promise.all([
      Promise.allSettled(videoPromises),
      musicPromise,
    ])

    musicDataUrl = musicResult

    // Collect successful videos
    const sceneResults: SceneResult[] = []
    for (const result of videoResults) {
      if (result.status === "fulfilled") {
        const val = result.value
        sceneResults.push({
          sceneNumber: val.sceneNumber,
          imageDataUrl: val.imageDataUrl,
          videoDataUrl: val.videoDataUrl,
          originalDuration: val.originalDuration,
          trimmedDuration: null,
          imagePrompt: val.imagePrompt,
          animationPrompt: val.animationPrompt,
          purpose: val.purpose,
          auditResult: val.auditResult,
        })
      } else {
        logWarn(ROUTE, `Video generation failed: ${result.reason}`)
      }
    }

    if (sceneResults.length === 0) {
      return NextResponse.json({ error: "All video generations failed" }, { status: 502 })
    }

    // Sort by scene number for correct narrative order
    sceneResults.sort((a, b) => a.sceneNumber - b.sceneNumber)

    logInfo(ROUTE, `Step 2 done: ${sceneResults.length} videos, music: ${musicDataUrl ? "yes" : "no"}`)

    // ── STEP 3: Assemble final reel ──────────────────────────────
    logInfo(ROUTE, "Step 3: Assembling final reel")

    const targetDuration = assembly.targetDuration || undefined
    const cutStyle = assembly.cutStyle || "fast"

    if (cutStyle === "fast" && targetDuration) {
      const trimPer = targetDuration / sceneResults.length
      for (const scene of sceneResults) {
        scene.trimmedDuration = Math.round(trimPer * 10) / 10
      }
    }

    const assemblyResult = await assembleVideo({
      clips: sceneResults.map(s => ({
        videoDataUrl: s.videoDataUrl,
        trimDuration: cutStyle === "fast" && targetDuration
          ? targetDuration / sceneResults.length
          : undefined,
      })),
      music: musicDataUrl ? {
        audioDataUrl: musicDataUrl,
        fadeIn: assembly.musicFadeIn || 1.0,
        fadeOut: assembly.musicFadeOut || 2.0,
      } : undefined,
      textOverlays: assembly.textOverlays,
      watermark: assembly.watermark,
      resolution: assembly.resolution || "1080x1920",
      fps: assembly.fps || 30,
      cutStyle,
      targetDuration,
    })

    logInfo(ROUTE, "Step 3 done: Final reel assembled")

    // ── STEP 4: Final video audit ────────────────────────────────
    logInfo(ROUTE, "Step 4: Final video quality audit")

    let videoAudit: VideoAuditResult | undefined
    try {
      videoAudit = await auditVideo(assemblyResult.videoDataUrl, concept)
    } catch (err) {
      logWarn(ROUTE, `Final video audit failed: ${(err as Error).message}`)
    }

    // ── Record to brief history ──────────────────────────────────
    const imageScores = sceneResults.map(s => s.auditResult?.score ?? 0)
    const avgImageScore = imageScores.length > 0
      ? Math.round((imageScores.reduce((a, b) => a + b, 0) / imageScores.length) * 10) / 10
      : 0

    if (requestBrief) {
      recordBrief({
        id: reelId,
        timestamp: new Date().toISOString(),
        brand: body.brand || "unknown",
        niche: body.niche || "unknown",
        platform: body.platform || "instagram",
        tone: body.tone,
        hookStatement: requestBrief.hookStatement,
        concept,
        viralScore: requestBrief.viralScore,
        viralReasoning: requestBrief.viralReasoning,
        sceneCount: sceneResults.length,
        imageScores,
        avgImageScore,
        finalVideoScore: videoAudit?.score,
        finalVideoVerdict: videoAudit?.verdict,
      })
    }

    if (videoAudit && requestBrief) {
      updateVideoScore(reelId, videoAudit.score, videoAudit.verdict)
    }

    // ── Build response ───────────────────────────────────────────
    costs.total = costs.images + costs.videos + costs.music

    return NextResponse.json({
      id: reelId,
      status: "complete",
      concept,
      brief: requestBrief || undefined,
      videoDataUrl: assemblyResult.videoDataUrl,
      duration: assemblyResult.duration,
      fileSize: assemblyResult.fileSize,
      scenes: sceneResults.map(s => ({
        sceneNumber: s.sceneNumber,
        imageDataUrl: s.imageDataUrl,
        videoDataUrl: s.videoDataUrl,
        originalDuration: s.originalDuration,
        trimmedDuration: s.trimmedDuration,
        imagePrompt: s.imagePrompt,
        animationPrompt: s.animationPrompt,
        purpose: s.purpose,
        auditResult: s.auditResult,
      })),
      imageSelection: {
        generated: selection.totalGenerated,
        selected: selection.selected.length,
        dropped: selection.dropped,
        retried: selection.totalRetried,
      },
      videoAudit: videoAudit || undefined,
      musicDataUrl,
      cost: {
        images: costs.images,
        videos: Math.round(costs.videos * 100) / 100,
        music: costs.music,
        total: Math.round(costs.total * 100) / 100,
      },
    })
  } catch (err) {
    logWarn(ROUTE, `Pipeline failed: ${(err as Error).message}`)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
