import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { generateVideo } from "@/lib/video-gen"
import { logInfo, logWarn } from "@/lib/logger"
import { v4 as uuid } from "uuid"

const ROUTE = "api/video/generate"

// Vercel max timeout is 300s — single clip Veo gen fits within this
export const maxDuration = 300

interface VideoRequest {
  prompt: string                // animation/motion prompt
  imageDataUrl?: string         // optional: reference image (base64 data URL)
  duration?: number             // 4-8 seconds (integer), default 4
  aspectRatio?: string          // "9:16", "16:9", "1:1", default "9:16"
  model?: string                // override model
}

export async function POST(request: NextRequest) {
  logInfo(ROUTE, "Request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: VideoRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { prompt, imageDataUrl, duration, aspectRatio, model } = body

  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 5) {
    return NextResponse.json({ error: "prompt (string, min 5 chars) is required" }, { status: 400 })
  }

  // Parse image data URL if provided
  let imageBase64: string | undefined
  let imageMimeType: string | undefined
  if (imageDataUrl) {
    const match = imageDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (!match) {
      return NextResponse.json({ error: "Invalid imageDataUrl format" }, { status: 400 })
    }
    imageMimeType = match[1]
    imageBase64 = match[2]
  }

  try {
    const result = await generateVideo(prompt, {
      imageBase64,
      imageMimeType,
      duration,
      aspectRatio,
      model,
    })

    return NextResponse.json({
      id: uuid(),
      videoDataUrl: result.videoDataUrl,
      mimeType: result.mimeType,
      model: result.model,
      prompt: result.prompt,
      duration: result.duration,
      estimatedCost: result.estimatedCost,
    })
  } catch (err) {
    logWarn(ROUTE, `Failed: ${(err as Error).message}`)
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
