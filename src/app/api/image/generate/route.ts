import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { generateImage, generateImages } from "@/lib/image-gen"
import { logInfo, logWarn } from "@/lib/logger"
import { v4 as uuid } from "uuid"

const ROUTE = "api/image/generate"

interface ImageRequest {
  prompt: string
  prompts?: string[]    // batch mode: generate multiple images
  model?: string        // override model (default: Nano Banana Pro)
  count?: number        // how many images for a single prompt (default: 1)
}

export async function POST(request: NextRequest) {
  logInfo(ROUTE, "Request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: ImageRequest
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { prompt, prompts, model, count = 1 } = body

  // Batch mode: multiple different prompts
  if (prompts && prompts.length > 0) {
    if (prompts.length > 8) {
      return NextResponse.json({ error: "Max 8 prompts per batch" }, { status: 400 })
    }

    logInfo(ROUTE, `Batch mode: ${prompts.length} prompts`)
    const results = await generateImages(prompts, model)

    if (results.length === 0) {
      return NextResponse.json({ error: "All image generations failed" }, { status: 502 })
    }

    return NextResponse.json({
      images: results.map(r => ({
        id: uuid(),
        imageDataUrl: r.imageDataUrl,
        mimeType: r.mimeType,
        model: r.model,
        prompt: r.prompt,
      })),
      count: results.length,
      requested: prompts.length,
    })
  }

  // Single mode
  if (!prompt || typeof prompt !== "string" || prompt.trim().length < 5) {
    return NextResponse.json({ error: "prompt (string, min 5 chars) is required" }, { status: 400 })
  }

  try {
    if (count > 1) {
      // Multiple images from same prompt
      const batchCount = Math.min(count, 4)
      logInfo(ROUTE, `Single prompt, ${batchCount} variations`)
      const results = await generateImages(
        Array(batchCount).fill(prompt),
        model
      )

      if (results.length === 0) {
        return NextResponse.json({ error: "Image generation failed" }, { status: 502 })
      }

      return NextResponse.json({
        images: results.map(r => ({
          id: uuid(),
          imageDataUrl: r.imageDataUrl,
          mimeType: r.mimeType,
          model: r.model,
          prompt: r.prompt,
        })),
        count: results.length,
        requested: batchCount,
      })
    }

    // Single image
    const result = await generateImage(prompt, { model })

    return NextResponse.json({
      id: uuid(),
      imageDataUrl: result.imageDataUrl,
      mimeType: result.mimeType,
      model: result.model,
      prompt: result.prompt,
    })
  } catch (err) {
    logWarn(ROUTE, `Failed: ${(err as Error).message}`)
    return NextResponse.json({ error: (err as Error).message }, { status: 502 })
  }
}
