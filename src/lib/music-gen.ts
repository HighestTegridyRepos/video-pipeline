import { GoogleGenAI } from "@google/genai"
import { LYRIA_REALTIME } from "./gemini"
import { logInfo, logWarn } from "./logger"
import { execSync } from "child_process"
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "fs"
import { join } from "path"
import { v4 as uuid } from "uuid"

const ROUTE = "music-gen"

export interface MusicGenResult {
  audioDataUrl: string
  mimeType: string
  model: string
  prompt: string
  duration: number
  sampleRate: number
}

// ── Lyria RealTime client (v1alpha required) ──────────────────────

let _lyriaClient: GoogleGenAI | null = null

function getLyriaClient(): GoogleGenAI {
  if (_lyriaClient) return _lyriaClient
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error("GEMINI_API_KEY environment variable is required")
  // Lyria RealTime requires v1alpha API version
  _lyriaClient = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" })
  return _lyriaClient
}

// ── WAV conversion helper ─────────────────────────────────────────

function rawPcmToWav(pcmData: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
  const dataLength = pcmData.length
  const buffer = Buffer.alloc(44 + dataLength)

  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write("WAVE", 8)
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28)
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(dataLength, 40)

  pcmData.copy(buffer, 44)
  return buffer
}

// ── Lyria RealTime (WebSocket streaming) ──────────────────────────

export async function generateMusicRealtime(
  prompt: string,
  options: {
    duration?: number
    bpm?: number
    temperature?: number
  } = {},
): Promise<MusicGenResult> {
  const duration = options.duration || 15
  const bpm = options.bpm || 120
  const ai = getLyriaClient()

  logInfo(ROUTE, `Lyria RealTime: generating ${duration}s of music`, { bpm })

  const sampleRate = 48000
  const channels = 1 // Lyria RealTime outputs mono
  const allAudio: Buffer[] = []

  return new Promise<MusicGenResult>((resolve, reject) => {
    const timeoutMs = (duration + 45) * 1000
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      // If we have some audio, return what we got
      if (allAudio.length > 0) {
        const pcm = Buffer.concat(allAudio)
        const actualDuration = pcm.length / (sampleRate * 2) // 16-bit = 2 bytes
        logInfo(ROUTE, `Timeout but got ${actualDuration.toFixed(1)}s of audio, returning it`)
        const wav = rawPcmToWav(pcm, sampleRate, channels, 16)
        resolve({
          audioDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
          mimeType: "audio/wav",
          model: LYRIA_REALTIME,
          prompt,
          duration: Math.round(actualDuration),
          sampleRate,
        })
      } else {
        reject(new Error(`Lyria RealTime timed out after ${duration + 45}s with no audio`))
      }
    }, timeoutMs)

    ai.live.music.connect({
      model: LYRIA_REALTIME,
      callbacks: {
        onmessage: (msg) => {
          if (msg.setupComplete) {
            logInfo(ROUTE, "Lyria setup complete")
            return
          }
          if (msg.filteredPrompt) {
            logWarn(ROUTE, `Prompt filtered: ${JSON.stringify(msg.filteredPrompt)}`)
            return
          }
          if (msg.serverContent?.audioChunks) {
            for (const chunk of msg.serverContent.audioChunks) {
              if (chunk.data) {
                // chunk.data is base64-encoded raw PCM bytes
                allAudio.push(Buffer.from(chunk.data, "base64"))
              }
            }
            const totalBytes = allAudio.reduce((sum, b) => sum + b.length, 0)
            const elapsed = totalBytes / (sampleRate * 2)
            if (Math.floor(elapsed) % 5 === 0 && Math.floor(elapsed) > 0) {
              logInfo(ROUTE, `Audio: ${elapsed.toFixed(1)}s / ${duration}s`)
            }
            // Check if we have enough
            if (elapsed >= duration) {
              if (settled) return
              settled = true
              clearTimeout(timeout)
              const pcm = Buffer.concat(allAudio)
              const targetBytes = duration * sampleRate * 2
              const trimmed = pcm.subarray(0, targetBytes)
              const wav = rawPcmToWav(trimmed, sampleRate, channels, 16)
              logInfo(ROUTE, `Lyria complete: ${(wav.length / 1024 / 1024).toFixed(1)}MB WAV`)
              resolve({
                audioDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
                mimeType: "audio/wav",
                model: LYRIA_REALTIME,
                prompt,
                duration,
                sampleRate,
              })
            }
          }
        },
        onerror: (e) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          logWarn(ROUTE, `Lyria WebSocket error: ${e.message}`)
          reject(new Error(`Lyria RealTime failed: ${e.message}`))
        },
        onclose: () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          if (allAudio.length > 0) {
            const pcm = Buffer.concat(allAudio)
            const actualDuration = pcm.length / (sampleRate * 2)
            logInfo(ROUTE, `Connection closed with ${actualDuration.toFixed(1)}s audio`)
            const wav = rawPcmToWav(pcm, sampleRate, channels, 16)
            resolve({
              audioDataUrl: `data:audio/wav;base64,${wav.toString("base64")}`,
              mimeType: "audio/wav",
              model: LYRIA_REALTIME,
              prompt,
              duration: Math.round(actualDuration),
              sampleRate,
            })
          } else {
            reject(new Error("Lyria connection closed with no audio"))
          }
        },
      },
    }).then(async (session) => {
      logInfo(ROUTE, "Lyria connected, setting prompts...")

      await session.setWeightedPrompts({
        weightedPrompts: [{ text: prompt, weight: 1.0 }],
      })

      await session.setMusicGenerationConfig({
        musicGenerationConfig: {
          bpm,
          ...(options.temperature != null ? { temperature: options.temperature } : {}),
        },
      })

      logInfo(ROUTE, "Starting playback...")
      session.play()
    }).catch((err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      logWarn(ROUTE, `Lyria connect failed: ${(err as Error).message}`)
      reject(new Error(`Failed to connect to Lyria: ${(err as Error).message}`))
    })
  })
}

// ── Lyria 3 (Vertex AI REST — supports vocals) ───────────────────

export async function generateMusicVertex(
  prompt: string,
  options: {
    duration?: number
    sampleCount?: number
  } = {},
): Promise<MusicGenResult> {
  const projectId = process.env.VERTEX_PROJECT_ID || "ghostkey-music"
  const location = process.env.VERTEX_LOCATION || "us-central1"
  const model = "lyria-002"

  logInfo(ROUTE, `Lyria 3 (Vertex AI): generating music`, { model })

  // Get access token via gcloud
  let token: string
  try {
    token = execSync("gcloud auth print-access-token", { timeout: 10000 })
      .toString()
      .trim()
  } catch (err) {
    throw new Error(`gcloud auth failed — is gcloud configured? ${(err as Error).message}`)
  }

  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`

  const makeRequest = async (authToken: string) => {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: options.sampleCount || 1,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    return resp
  }

  let response = await makeRequest(token)

  // Retry once on 401 with a fresh token
  if (response.status === 401) {
    logWarn(ROUTE, "Vertex returned 401, refreshing gcloud token and retrying...")
    try {
      token = execSync("gcloud auth print-access-token", { timeout: 10000 })
        .toString()
        .trim()
    } catch (err) {
      throw new Error(`gcloud auth refresh failed: ${(err as Error).message}`)
    }
    response = await makeRequest(token)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Lyria 3 API error ${response.status}: ${text.slice(0, 300)}`)
  }

  const result = await response.json()
  const predictions = result.predictions || []

  if (predictions.length === 0) {
    throw new Error("Lyria 3 returned no predictions")
  }

  const audioData = predictions[0].audioContent || predictions[0].audio_content || predictions[0].bytesBase64Encoded
  if (!audioData) {
    logWarn(ROUTE, `Lyria 3 prediction keys: ${Object.keys(predictions[0]).join(", ")}`)
    throw new Error("Lyria 3 returned no audio content")
  }

  // audioData is base64-encoded WAV
  const audioBuffer = Buffer.from(audioData, "base64")
  const audioDuration = audioBuffer.length / (48000 * 2) // rough estimate

  logInfo(ROUTE, `Lyria 3 complete: ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB`)

  return {
    audioDataUrl: `data:audio/wav;base64,${audioData}`,
    mimeType: "audio/wav",
    model: `lyria-002`,
    prompt,
    duration: Math.round(audioDuration),
    sampleRate: 48000,
  }
}

// ── Unified entry point ───────────────────────────────────────────
// NOTE: Lyria RealTime (WebSocket) is disabled — ai.live.music.connect()
// is broken in @google/genai v1.46+. All music routes through Vertex/Lyria 3.

export async function generateMusic(
  prompt: string,
  options: {
    duration?: number
    bpm?: number
    instrumental?: boolean
    temperature?: number
    vocals?: boolean  // true → use Lyria 3 (Vertex AI) for vocals
  } = {},
): Promise<MusicGenResult> {
  logInfo(ROUTE, `Using Lyria 3 (Vertex AI) for music generation (vocals: ${options.vocals ?? false})`)
  return generateMusicVertex(prompt, { duration: options.duration })
}
