import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { assembleVideo, AssemblyOptions, TextOverlay, Watermark } from "@/lib/assembly"
import { logInfo, logWarn } from "@/lib/logger"
import { v4 as uuid } from "uuid"

const ROUTE = "api/video/assemble"

// Assembly can take time with multiple clips
export const maxDuration = 120

interface AssembleRequest {
  clips: Array<{
    videoDataUrl: string
    trimDuration?: number
  }>
  music?: {
    audioDataUrl: string
    fadeIn?: number
    fadeOut?: number
  }
  textOverlays?: TextOverlay[]
  watermark?: Watermark
  aspectRatio?: string
  resolution?: string
  fps?: number
  cutStyle?: "fast" | "full"
  targetDuration?: number
  transitionType?: "cut" | "crossfade" | "none"
}

export async function POST(request: NextRequest) {
  logInfo(ROUTE, "Request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: AssembleRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { clips } = body

  if (!clips || !Array.isArray(clips) || clips.length === 0) {
    return NextResponse.json({ error: "clips array with at least 1 clip is required" }, { status: 400 })
  }

  if (clips.length > 10) {
    return NextResponse.json({ error: "Max 10 clips per assembly" }, { status: 400 })
  }

  // Validate all clips have valid data URLs
  for (let i = 0; i < clips.length; i++) {
    if (!clips[i].videoDataUrl || !clips[i].videoDataUrl.startsWith("data:")) {
      return NextResponse.json({ error: `Clip ${i} has invalid videoDataUrl` }, { status: 400 })
    }
  }

  try {
    const options: AssemblyOptions = {
      clips: body.clips,
      music: body.music,
      textOverlays: body.textOverlays,
      watermark: body.watermark,
      aspectRatio: body.aspectRatio,
      resolution: body.resolution,
      fps: body.fps,
      cutStyle: body.cutStyle,
      targetDuration: body.targetDuration,
      transitionType: body.transitionType,
    }

    const result = await assembleVideo(options)

    return NextResponse.json({
      id: uuid(),
      videoDataUrl: result.videoDataUrl,
      mimeType: result.mimeType,
      duration: result.duration,
      fileSize: result.fileSize,
    })
  } catch (err) {
    logWarn(ROUTE, `Failed: ${(err as Error).message}`)
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
