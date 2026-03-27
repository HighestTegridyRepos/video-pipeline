import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { generateIdea, IdeaGenInput } from "@/lib/idea-gen"
import { logInfo, logWarn } from "@/lib/logger"

export const maxDuration = 60

export async function POST(request: NextRequest) {
  logInfo("api/video/idea", "Idea request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: IdeaGenInput
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.brand || !body.niche) {
    return NextResponse.json(
      { error: "brand and niche are required" },
      { status: 400 }
    )
  }

  try {
    const brief = await generateIdea({
      brand: body.brand,
      niche: body.niche,
      platform: body.platform || "instagram",
      format: body.format || "reel",
      tone: body.tone,
      avoid: body.avoid,
      count: body.count,
    })

    if (brief.error) {
      return NextResponse.json(
        { error: brief.reason || "Idea generation failed" },
        { status: 400 }
      )
    }

    return NextResponse.json(brief)
  } catch (err) {
    logWarn("api/video/idea", `Failed: ${(err as Error).message}`)
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    )
  }
}
