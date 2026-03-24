import { logInfo, logWarn } from "./logger"
import { execSync } from "child_process"
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { v4 as uuid } from "uuid"

const ROUTE = "assembly"

export interface TextOverlay {
  text: string
  position: "top-center" | "center" | "bottom-center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  startTime: number
  endTime: number
  fontSize?: number
  color?: string
  style?: "bold-shadow" | "plain" | "outline"
}

export interface Watermark {
  text: string
  position: "bottom-right" | "bottom-left" | "top-right" | "top-left"
  opacity?: number
}

export interface AssemblyOptions {
  clips: Array<{
    videoDataUrl: string    // base64 data URL of video clip
    trimDuration?: number   // trim to this many seconds (optional)
  }>
  music?: {
    audioDataUrl: string    // base64 data URL of audio
    fadeIn?: number         // fade in duration in seconds
    fadeOut?: number        // fade out duration in seconds
  }
  textOverlays?: TextOverlay[]
  watermark?: Watermark
  aspectRatio?: string      // "9:16", "16:9", "1:1"
  resolution?: string       // "1080x1920", etc
  fps?: number              // default 30
  format?: string           // default "mp4"
  cutStyle?: "fast" | "full"
  targetDuration?: number   // for "fast" cut style
  transitionType?: "cut" | "crossfade" | "none"
}

export interface AssemblyResult {
  videoDataUrl: string
  mimeType: string
  duration: number
  fileSize: number
}

/**
 * Parse data URL to buffer and write to temp file.
 */
function dataUrlToFile(dataUrl: string, filePath: string): void {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/)
  if (!match) throw new Error("Invalid data URL")
  writeFileSync(filePath, Buffer.from(match[1], "base64"))
}

/**
 * Get position coordinates for text overlays.
 */
function getPositionExpr(position: string, fontSize: number): { x: string; y: string } {
  switch (position) {
    case "top-center": return { x: "(w-text_w)/2", y: `${Math.round(fontSize * 1.5)}` }
    case "top-left": return { x: "20", y: `${Math.round(fontSize * 1.5)}` }
    case "top-right": return { x: "w-text_w-20", y: `${Math.round(fontSize * 1.5)}` }
    case "center": return { x: "(w-text_w)/2", y: "(h-text_h)/2" }
    case "bottom-center": return { x: "(w-text_w)/2", y: `h-${Math.round(fontSize * 2.5)}` }
    case "bottom-left": return { x: "20", y: `h-${Math.round(fontSize * 2.5)}` }
    case "bottom-right": return { x: "w-text_w-20", y: `h-${Math.round(fontSize * 2.5)}` }
    default: return { x: "(w-text_w)/2", y: `h-${Math.round(fontSize * 2.5)}` }
  }
}

/**
 * Assemble video clips with optional music, text overlays, and watermark.
 */
export async function assembleVideo(options: AssemblyOptions): Promise<AssemblyResult> {
  const {
    clips,
    music,
    textOverlays = [],
    watermark,
    resolution = "1080x1920",
    fps = 30,
    cutStyle = "full",
    targetDuration,
    transitionType = "cut",
  } = options

  if (clips.length === 0) throw new Error("At least one clip is required")

  // Create temp directory
  const tmpDir = join("/tmp", `video-assembly-${uuid()}`)
  mkdirSync(tmpDir, { recursive: true })

  try {
    logInfo(ROUTE, `Assembling ${clips.length} clips`, { cutStyle, resolution })

    // ── 1. Write clips to temp files and trim if needed ──────────
    const clipPaths: string[] = []
    for (let i = 0; i < clips.length; i++) {
      const rawPath = join(tmpDir, `clip_raw_${i}.mp4`)
      dataUrlToFile(clips[i].videoDataUrl, rawPath)

      let trimDuration = clips[i].trimDuration
      if (cutStyle === "fast" && targetDuration && !trimDuration) {
        trimDuration = targetDuration / clips.length
      }

      if (trimDuration) {
        const trimmedPath = join(tmpDir, `clip_${i}.mp4`)
        execSync(
          `ffmpeg -y -i "${rawPath}" -t ${trimDuration} -c copy "${trimmedPath}" 2>/dev/null`,
          { timeout: 30000 }
        )
        clipPaths.push(trimmedPath)
      } else {
        clipPaths.push(rawPath)
      }
    }

    // ── 1.5. Force-crop to remove letterboxing ─────────────────
    // Scale up to fill target resolution and center-crop (removes black bars)
    const [resW, resH] = resolution.split("x").map(Number)
    const croppedPaths: string[] = []
    for (let i = 0; i < clipPaths.length; i++) {
      const croppedPath = join(tmpDir, `clip_cropped_${i}.mp4`)
      try {
        execSync(
          `ffmpeg -y -i "${clipPaths[i]}" -vf "scale=${resW}:${resH}:force_original_aspect_ratio=increase,crop=${resW}:${resH}" -c:v libx264 -preset fast -c:a copy "${croppedPath}" 2>/dev/null`,
          { timeout: 30000 }
        )
        croppedPaths.push(croppedPath)
      } catch {
        // If crop fails, use original clip
        croppedPaths.push(clipPaths[i])
      }
    }

    // ── 2. Concatenate clips ─────────────────────────────────────
    const concatListPath = join(tmpDir, "concat.txt")
    const concatContent = croppedPaths.map(p => `file '${p}'`).join("\n")
    writeFileSync(concatListPath, concatContent)

    const concatPath = join(tmpDir, "concat.mp4")
    if (transitionType === "crossfade" && clipPaths.length > 1) {
      // Crossfade requires filter_complex — simplified for 2 clips
      // For more complex crossfades, would need iterative approach
      const inputs = clipPaths.map(p => `-i "${p}"`).join(" ")
      execSync(
        `ffmpeg -y ${inputs} -filter_complex "concat=n=${clipPaths.length}:v=1:a=0" -c:v libx264 -preset fast "${concatPath}" 2>/dev/null`,
        { timeout: 60000 }
      )
    } else {
      execSync(
        `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${concatPath}" 2>/dev/null`,
        { timeout: 60000 }
      )
    }

    // ── 3. Build filter chain for overlays ───────────────────────
    let currentInput = concatPath

    // Ensure final resolution + fps (clips already cropped to fill in step 1.5)
    const scaledPath = join(tmpDir, "scaled.mp4")
    execSync(
      `ffmpeg -y -i "${currentInput}" -vf "scale=${resW}:${resH}:force_original_aspect_ratio=increase,crop=${resW}:${resH}" -c:v libx264 -preset fast -r ${fps} "${scaledPath}" 2>/dev/null`,
      { timeout: 60000 }
    )
    currentInput = scaledPath

    // ── 4. Text overlays + watermark ─────────────────────────────
    const drawTextFilters: string[] = []

    for (const overlay of textOverlays) {
      const fontSize = overlay.fontSize || 48
      const color = overlay.color || "white"
      const { x, y } = getPositionExpr(overlay.position, fontSize)
      const escapedText = overlay.text.replace(/'/g, "'\\''").replace(/:/g, "\\:")

      let filter = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}`
      filter += `:enable='between(t,${overlay.startTime},${overlay.endTime})'`

      if (overlay.style === "bold-shadow" || !overlay.style) {
        filter += `:shadowcolor=black@0.6:shadowx=2:shadowy=2`
      } else if (overlay.style === "outline") {
        filter += `:borderw=2:bordercolor=black`
      }

      drawTextFilters.push(filter)
    }

    if (watermark) {
      const opacity = watermark.opacity || 0.7
      const wSize = Math.round(resW * 0.022)
      const { x, y } = getPositionExpr(watermark.position, wSize)
      const escapedText = watermark.text.replace(/'/g, "'\\''").replace(/:/g, "\\:")
      drawTextFilters.push(
        `drawtext=text='${escapedText}':fontsize=${wSize}:fontcolor=white@${opacity}:x=${x}:y=${y}`
      )
    }

    if (drawTextFilters.length > 0) {
      const overlayPath = join(tmpDir, "overlaid.mp4")
      const filterStr = drawTextFilters.join(",")
      execSync(
        `ffmpeg -y -i "${currentInput}" -vf "${filterStr}" -c:v libx264 -preset fast -c:a copy "${overlayPath}" 2>/dev/null`,
        { timeout: 60000 }
      )
      currentInput = overlayPath
    }

    // ── 5. Add music track ───────────────────────────────────────
    if (music) {
      const musicPath = join(tmpDir, "music.wav")
      dataUrlToFile(music.audioDataUrl, musicPath)

      const fadeIn = music.fadeIn || 1
      const fadeOut = music.fadeOut || 2

      // Get video duration
      const durationStr = execSync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${currentInput}" 2>/dev/null`
      ).toString().trim()
      const videoDuration = parseFloat(durationStr) || 15

      const fadeOutStart = Math.max(0, videoDuration - fadeOut)
      const finalPath = join(tmpDir, "final.mp4")

      execSync(
        `ffmpeg -y -i "${currentInput}" -i "${musicPath}" -filter_complex "[1:a]atrim=0:${videoDuration},afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut}[a]" -map 0:v -map "[a]" -c:v copy -shortest "${finalPath}" 2>/dev/null`,
        { timeout: 60000 }
      )
      currentInput = finalPath
    }

    // ── 6. Read final output ─────────────────────────────────────
    const outputBuffer = readFileSync(currentInput)
    const outputBase64 = outputBuffer.toString("base64")

    // Get duration
    let finalDuration = 0
    try {
      const dur = execSync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${currentInput}" 2>/dev/null`
      ).toString().trim()
      finalDuration = parseFloat(dur) || 0
    } catch { /* */ }

    logInfo(ROUTE, `Assembly complete`, {
      duration: finalDuration,
      fileSize: outputBuffer.length,
      clips: clips.length,
    })

    return {
      videoDataUrl: `data:video/mp4;base64,${outputBase64}`,
      mimeType: "video/mp4",
      duration: Math.round(finalDuration * 10) / 10,
      fileSize: outputBuffer.length,
    }
  } finally {
    // Clean up temp files
    try {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* */ }
  }
}
