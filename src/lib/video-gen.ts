import { getGeminiClient, VIDEO_MODEL, VEO_3_1_FAST } from "./gemini"
import { logInfo, logWarn } from "./logger"

const ROUTE = "video-gen"

// Estimated cost per clip for logging
const COST_PER_CLIP: Record<string, number> = {
  "veo-3.1-generate-preview": 1.60,
  "veo-3.1-fast-generate-preview": 0.80,
  "veo-3.0-generate-001": 1.20,
}

export interface VideoGenResult {
  videoDataUrl: string
  mimeType: string
  model: string
  prompt: string
  duration: number
  estimatedCost: number
}

/**
 * Generate a video clip using Veo 3.1.
 * Accepts an optional reference image (base64) for image-to-video.
 * Duration must be an integer 4-8 seconds.
 */
export async function generateVideo(
  prompt: string,
  options: {
    imageBase64?: string
    imageMimeType?: string
    duration?: number
    aspectRatio?: string
    model?: string
  } = {},
): Promise<VideoGenResult> {
  const activeModel = options.model || VIDEO_MODEL
  const duration = Math.min(Math.max(Math.round(options.duration || 4), 4), 8)
  const aspectRatio = options.aspectRatio || "9:16"
  const ai = getGeminiClient()

  logInfo(ROUTE, `Generating video with ${activeModel}`, {
    duration,
    aspectRatio,
    hasRefImage: !!options.imageBase64,
    promptLength: prompt.length,
  })

  // Build the request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const generateConfig: any = {
    model: activeModel,
    prompt,
    config: {
      aspectRatio,
    },
  }

  // Add reference image if provided
  if (options.imageBase64) {
    generateConfig.image = {
      imageBytes: options.imageBase64,
      mimeType: options.imageMimeType || "image/png",
    }
  }

  // Start video generation (returns an operation to poll)
  let operation = await ai.models.generateVideos(generateConfig)

  logInfo(ROUTE, "Video generation started, polling for completion...")

  // Poll until done (Veo takes 30-120s typically)
  const maxPolls = 60 // 10s intervals × 60 = 10 min max
  let polls = 0
  while (!operation.done && polls < maxPolls) {
    await new Promise(r => setTimeout(r, 10_000)) // 10s intervals
    operation = await ai.operations.getVideosOperation({ operation })
    polls++
    if (polls % 3 === 0) {
      logInfo(ROUTE, `Still processing... (${polls * 10}s elapsed)`)
    }
  }

  if (!operation.done) {
    throw new Error("Video generation timed out after 10 minutes")
  }

  // Extract video from typed response
  const generatedVideo = operation.response?.generatedVideos?.[0]
  if (!generatedVideo?.video) {
    throw new Error("Video generation returned no video")
  }

  let videoBase64: string | null = null
  const videoMimeType = generatedVideo.video.mimeType || "video/mp4"

  // Try videoBytes first (base64 encoded), then download from URI
  if (generatedVideo.video.videoBytes) {
    videoBase64 = generatedVideo.video.videoBytes
  } else if (generatedVideo.video.uri) {
    const apiKey = process.env.GEMINI_API_KEY
    logInfo(ROUTE, `Downloading video from URI...`)
    const resp = await fetch(generatedVideo.video.uri, {
      headers: { "X-Goog-Api-Key": apiKey || "" },
    })
    if (!resp.ok) {
      throw new Error(`Failed to download video: ${resp.status}`)
    }
    const arrayBuf = await resp.arrayBuffer()
    videoBase64 = Buffer.from(arrayBuf).toString("base64")
  }

  if (!videoBase64) {
    throw new Error("Could not extract video data from response")
  }

  const estimatedCost = COST_PER_CLIP[activeModel] || 1.60
  logInfo(ROUTE, `Video generated successfully`, { duration, estimatedCost })

  return {
    videoDataUrl: `data:${videoMimeType};base64,${videoBase64}`,
    mimeType: videoMimeType,
    model: activeModel,
    prompt,
    duration,
    estimatedCost,
  }
}
