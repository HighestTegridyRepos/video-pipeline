import { NextRequest, NextResponse } from "next/server"
import { checkApiKey } from "@/lib/auth"
import { addFeedback, loadHistory } from "@/lib/brief-history"
import { logInfo, logWarn } from "@/lib/logger"

export const maxDuration = 10

export async function POST(request: NextRequest) {
  logInfo("api/video/feedback", "Feedback request received")

  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  let body: { briefId: string; feedback: "great" | "good" | "mid" | "bad"; note?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.briefId || !body.feedback) {
    return NextResponse.json(
      { error: "briefId and feedback (great/good/mid/bad) are required" },
      { status: 400 }
    )
  }

  if (!["great", "good", "mid", "bad"].includes(body.feedback)) {
    return NextResponse.json(
      { error: "feedback must be one of: great, good, mid, bad" },
      { status: 400 }
    )
  }

  const success = addFeedback(body.briefId, body.feedback, body.note)
  if (!success) {
    return NextResponse.json({ error: "Brief not found" }, { status: 404 })
  }

  return NextResponse.json({ status: "ok" })
}

export async function GET(request: NextRequest) {
  if (!checkApiKey(request)) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
  }

  const entries = loadHistory()
  return NextResponse.json({
    count: entries.length,
    entries: entries.slice(-20).map(e => ({
      id: e.id,
      timestamp: e.timestamp,
      hookStatement: e.hookStatement,
      viralScore: e.viralScore,
      avgImageScore: e.avgImageScore,
      finalVideoScore: e.finalVideoScore,
      feedback: e.feedback,
      feedbackNote: e.feedbackNote,
    })),
  })
}
