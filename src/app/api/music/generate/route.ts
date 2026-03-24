import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { generateMusic } from "@/lib/music-gen"
import { logInfo, logWarn } from "@/lib/logger"
import { v4 as uuid } from "uuid"

const ROUTE = "api/music/generate"

// Music gen needs time for WebSocket streaming
export const maxDuration = 120

interface MusicRequest {
  prompt: string
  duration?: number       // seconds, default 15, max 60
  bpm?: number            // beats per minute, default 120
  instrumental?: boolean  // hint in prompt, default true
  temperature?: number    // generation temperature
  vocals?: boolean        // true → use Lyria 3 (Vertex AI) for vocals
}

export async function POST(request: NextRequest) {
  logInfo(ROUTE, "Request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: MusicRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { prompt, duration = 15, bpm = 120, instrumental = true, temperature, vocals = false } = body

  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 5) {
    return NextResponse.json({ error: "prompt (string, min 5 chars) is required" }, { status: 400 })
  }

  const clampedDuration = Math.min(Math.max(duration, 3), 60)

  // Build full prompt with instrumental hint
  const fullPrompt = instrumental
    ? `${prompt}. Instrumental only, no vocals.`
    : prompt

  try {
    const result = await generateMusic(fullPrompt, {
      duration: clampedDuration,
      bpm,
      instrumental,
      temperature,
      vocals,
    })

    return NextResponse.json({
      id: uuid(),
      audioDataUrl: result.audioDataUrl,
      mimeType: result.mimeType,
      model: result.model,
      prompt: fullPrompt,
      duration: result.duration,
      sampleRate: result.sampleRate,
    })
  } catch (err) {
    logWarn(ROUTE, `Failed: ${(err as Error).message}`)
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
