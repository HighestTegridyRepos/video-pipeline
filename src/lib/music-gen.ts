import { getGeminiClient, LYRIA_REALTIME } from "./gemini"
import { logInfo, logWarn } from "./logger"

const ROUTE = "music-gen"

export interface MusicGenResult {
  audioDataUrl: string
  mimeType: string
  model: string
  prompt: string
  duration: number
  sampleRate: number
}

/**
 * Convert raw PCM samples (Float32) to a WAV file buffer.
 * Lyria outputs 48kHz stereo Float32 PCM.
 */
function pcmToWav(samples: Float32Array, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = 2 // 16-bit output
  const dataLength = samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataLength)

  // RIFF header
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write("WAVE", 8)

  // fmt chunk
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)          // chunk size
  buffer.writeUInt16LE(1, 20)           // PCM format
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28) // byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, 32)              // block align
  buffer.writeUInt16LE(bytesPerSample * 8, 34)                     // bits per sample

  // data chunk
  buffer.write("data", 36)
  buffer.writeUInt32LE(dataLength, 40)

  // Convert float32 to int16
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    const val = s < 0 ? s * 0x8000 : s * 0x7FFF
    buffer.writeInt16LE(Math.round(val), 44 + i * 2)
  }

  return buffer
}

/**
 * Generate music using Lyria RealTime via WebSocket streaming.
 * Connects, sets prompt and config, plays, collects audio for the specified duration.
 */
export async function generateMusic(
  prompt: string,
  options: {
    duration?: number   // seconds, default 15
    bpm?: number        // beats per minute, default 120
    instrumental?: boolean
    temperature?: number
  } = {},
): Promise<MusicGenResult> {
  const duration = options.duration || 15
  const bpm = options.bpm || 120
  const ai = getGeminiClient()

  logInfo(ROUTE, `Generating music with Lyria RealTime`, {
    prompt: prompt.slice(0, 100),
    duration,
    bpm,
  })

  const sampleRate = 48000
  const channels = 2
  const samplesNeeded = sampleRate * channels * duration
  const allSamples: number[] = []

  return new Promise<MusicGenResult>((resolve, reject) => {
    const timeoutMs = (duration + 30) * 1000 // duration + 30s buffer
    const timeout = setTimeout(() => {
      reject(new Error(`Music generation timed out after ${duration + 30}s`))
    }, timeoutMs)

    ai.live.music.connect({
      model: LYRIA_REALTIME,
      callbacks: {
        onmessage: (msg) => {
          // Collect audio data from server messages
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const data = msg as any
          if (data.serverContent?.audioChunks) {
            for (const chunk of data.serverContent.audioChunks) {
              if (chunk.data) {
                // Decode base64 audio chunk to float32 samples
                const buf = Buffer.from(chunk.data, "base64")
                for (let i = 0; i < buf.length; i += 4) {
                  if (i + 4 <= buf.length) {
                    allSamples.push(buf.readFloatLE(i))
                  }
                }
              }
            }
          }

          // Check if we have enough samples
          if (allSamples.length >= samplesNeeded) {
            clearTimeout(timeout)
            // Convert to WAV
            const samples = new Float32Array(allSamples.slice(0, samplesNeeded))
            const wavBuffer = pcmToWav(samples, sampleRate, channels)
            const audioBase64 = wavBuffer.toString("base64")

            logInfo(ROUTE, `Music generated: ${(wavBuffer.length / 1024 / 1024).toFixed(1)}MB WAV`)

            resolve({
              audioDataUrl: `data:audio/wav;base64,${audioBase64}`,
              mimeType: "audio/wav",
              model: LYRIA_REALTIME,
              prompt,
              duration,
              sampleRate,
            })
          }
        },
        onerror: (e) => {
          clearTimeout(timeout)
          logWarn(ROUTE, `WebSocket error: ${e.message}`)
          reject(new Error(`Music generation failed: ${e.message}`))
        },
        onclose: () => {
          clearTimeout(timeout)
          // If we have some samples but not enough, return what we have
          if (allSamples.length > sampleRate * channels) { // at least 1 second
            const samples = new Float32Array(allSamples)
            const wavBuffer = pcmToWav(samples, sampleRate, channels)
            const actualDuration = allSamples.length / (sampleRate * channels)
            logInfo(ROUTE, `Connection closed early. Got ${actualDuration.toFixed(1)}s of audio`)
            resolve({
              audioDataUrl: `data:audio/wav;base64,${wavBuffer.toString("base64")}`,
              mimeType: "audio/wav",
              model: LYRIA_REALTIME,
              prompt,
              duration: Math.round(actualDuration),
              sampleRate,
            })
          } else {
            reject(new Error("Connection closed before enough audio was generated"))
          }
        },
      },
    }).then(async (session) => {
      // Set prompt
      await session.setWeightedPrompts({
        weightedPrompts: [{ text: prompt, weight: 1.0 }],
      })

      // Set config
      await session.setMusicGenerationConfig({
        musicGenerationConfig: {
          bpm,
          ...(options.temperature != null ? { temperature: options.temperature } : {}),
        },
      })

      // Start playback
      session.play()
      logInfo(ROUTE, "Music generation started, collecting audio...")
    }).catch((err) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to connect to Lyria: ${(err as Error).message}`))
    })
  })
}
