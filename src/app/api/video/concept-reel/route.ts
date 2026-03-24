import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { generateImage } from "@/lib/image-gen"
import { generateVideo } from "@/lib/video-gen"
import { generateMusic } from "@/lib/music-gen"
import { assembleVideo, TextOverlay, Watermark } from "@/lib/assembly"
import { logInfo, logWarn } from "@/lib/logger"
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
  imagePrompt: string
  animationPrompt: string
  duration?: number         // 4-8, default 4
  imageDataUrl?: string     // skip image gen if provided
}

interface MusicInput {
  prompt: string
  duration?: number         // seconds, default 20
  bpm?: number
  instrumental?: boolean
  vocals?: boolean          // true → use Lyria 3 (Vertex AI) for vocals
  musicDataUrl?: string     // skip music gen if provided
}

interface AssemblyInput {
  aspectRatio?: string      // "9:16", "16:9", "1:1"
  targetDuration?: number   // seconds
  cutStyle?: "fast" | "full"
  resolution?: string
  fps?: number
  textOverlays?: TextOverlay[]
  watermark?: Watermark
  musicFadeIn?: number
  musicFadeOut?: number
}

interface ConceptReelRequest {
  concept: string
  scenes: SceneInput[]
  music?: MusicInput
  assembly?: AssemblyInput
  videoModel?: string
}

interface SceneResult {
  imageDataUrl: string
  videoDataUrl: string
  originalDuration: number
  trimmedDuration: number | null
  imagePrompt: string
  animationPrompt: string
}

// ── Main handler ──────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  logInfo(ROUTE, "Concept reel request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: ConceptReelRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { concept, scenes, music, assembly = {}, videoModel } = body

  if (!concept || typeof concept !== "string") {
    return NextResponse.json({ error: "concept (string) is required" }, { status: 400 })
  }

  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return NextResponse.json({ error: "scenes array with at least 1 scene is required" }, { status: 400 })
  }

  if (scenes.length > 8) {
    return NextResponse.json({ error: "Max 8 scenes per concept reel" }, { status: 400 })
  }

  const costs = { images: 0, videos: 0, music: 0, total: 0 }

  try {
    // ── STEP 1: Generate all hero images (parallel) ──────────────
    logInfo(ROUTE, `Step 1: Generating ${scenes.length} hero images`)

    const aspectRatio = assembly.aspectRatio || "9:16"

    // Determine orientation suffix for image prompts based on aspect ratio
    let orientationSuffix = ""
    if (aspectRatio === "9:16") {
      orientationSuffix = " Portrait orientation, vertical composition, taller than wide, 9:16 aspect ratio."
    } else if (aspectRatio === "16:9") {
      orientationSuffix = " Landscape orientation, horizontal composition, wider than tall, 16:9 aspect ratio."
    } else if (aspectRatio === "1:1") {
      orientationSuffix = " Square composition, 1:1 aspect ratio."
    }

    const imageResults = await Promise.allSettled(
      scenes.map(async (scene) => {
        if (scene.imageDataUrl) {
          logInfo(ROUTE, "Using provided image, skipping generation")
          return { imageDataUrl: scene.imageDataUrl, skipped: true }
        }
        // Append orientation to prompt so Nano Banana generates correct aspect ratio
        const orientedPrompt = scene.imagePrompt + orientationSuffix
        const result = await generateImage(orientedPrompt)
        costs.images += IMAGE_COST
        return { imageDataUrl: result.imageDataUrl, skipped: false }
      })
    )

    // Collect successful images, track failures
    const imageData: Array<{ imageDataUrl: string; index: number }> = []
    const failedScenes: number[] = []

    for (let i = 0; i < imageResults.length; i++) {
      if (imageResults[i].status === "fulfilled") {
        const val = (imageResults[i] as PromiseFulfilledResult<{ imageDataUrl: string; skipped: boolean }>).value
        imageData.push({ imageDataUrl: val.imageDataUrl, index: i })
      } else {
        const reason = (imageResults[i] as PromiseRejectedResult).reason
        logWarn(ROUTE, `Scene ${i} image failed: ${reason}`)
        failedScenes.push(i)
      }
    }

    if (imageData.length === 0) {
      return NextResponse.json({ error: "All image generations failed" }, { status: 502 })
    }

    logInfo(ROUTE, `Step 1 done: ${imageData.length}/${scenes.length} images generated`)

    // ── STEP 2: Generate videos + music (parallel) ───────────────
    logInfo(ROUTE, "Step 2: Generating videos and music in parallel")

    // Video generation promises
    const videoPromises = imageData.map(async ({ imageDataUrl, index }) => {
      const scene = scenes[index]
      const duration = Math.min(Math.max(Math.round(scene.duration || 4), 4), 8)

      // Parse image data URL for Veo
      const match = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
      if (!match) throw new Error(`Invalid image data URL for scene ${index}`)

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
        index,
        imageDataUrl,
        videoDataUrl: result.videoDataUrl,
        originalDuration: duration,
        imagePrompt: scene.imagePrompt,
        animationPrompt: scene.animationPrompt,
      }
    })

    // Music generation promise (parallel with videos)
    let musicDataUrl: string | null = null
    const musicPromise = (async () => {
      if (!music) return null
      if (music.musicDataUrl) {
        logInfo(ROUTE, "Using provided music, skipping generation")
        return music.musicDataUrl
      }
      try {
        logInfo(ROUTE, "Starting music generation...")
        const result = await generateMusic(
          music.instrumental !== false && !music.vocals
            ? `${music.prompt}. Instrumental only, no vocals.`
            : music.prompt,
          {
            duration: music.duration || 20,
            bpm: music.bpm || 120,
            instrumental: music.instrumental !== false,
            vocals: music.vocals || false,
          }
        )
        costs.music += MUSIC_COST
        logInfo(ROUTE, `Music generated: ${result.duration}s, model: ${result.model}`)
        return result.audioDataUrl
      } catch (err) {
        logWarn(ROUTE, `Music generation failed: ${(err as Error).message}`)
        return null // Non-fatal — video works without music
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
          imageDataUrl: val.imageDataUrl,
          videoDataUrl: val.videoDataUrl,
          originalDuration: val.originalDuration,
          trimmedDuration: null, // set after assembly
          imagePrompt: val.imagePrompt,
          animationPrompt: val.animationPrompt,
        })
      } else {
        logWarn(ROUTE, `Video generation failed: ${result.reason}`)
      }
    }

    if (sceneResults.length === 0) {
      return NextResponse.json({ error: "All video generations failed" }, { status: 502 })
    }

    logInfo(ROUTE, `Step 2 done: ${sceneResults.length} videos, music: ${musicDataUrl ? "yes" : "no"}`)

    // ── STEP 3: Assemble final reel ──────────────────────────────
    logInfo(ROUTE, "Step 3: Assembling final reel")

    const targetDuration = assembly.targetDuration || undefined
    const cutStyle = assembly.cutStyle || "fast"

    // Calculate trim durations for response
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

    // ── Build response ───────────────────────────────────────────
    costs.total = costs.images + costs.videos + costs.music

    return NextResponse.json({
      id: uuid(),
      status: "complete",
      concept,
      videoDataUrl: assemblyResult.videoDataUrl,
      duration: assemblyResult.duration,
      fileSize: assemblyResult.fileSize,
      scenes: sceneResults.map(s => ({
        imageDataUrl: s.imageDataUrl,
        videoDataUrl: s.videoDataUrl,
        originalDuration: s.originalDuration,
        trimmedDuration: s.trimmedDuration,
        imagePrompt: s.imagePrompt,
        animationPrompt: s.animationPrompt,
      })),
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
