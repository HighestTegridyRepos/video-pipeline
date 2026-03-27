import { GoogleGenAI } from "@google/genai"

let _client: GoogleGenAI | null = null

export function getGeminiClient() {
  if (_client) return _client
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required")
  }
  _client = new GoogleGenAI({ apiKey })
  return _client
}

// ── Image models ────────────────────────────────────────────────
export const NANO_BANANA_PRO = "gemini-3-pro-image-preview"
export const NANO_BANANA_2 = "gemini-3.1-flash-image-preview"
export const IMAGE_MODEL = NANO_BANANA_PRO

// ── Video models ────────────────────────────────────────────────
export const VEO_3_1 = "veo-3.1-generate-preview"
export const VEO_3_1_FAST = "veo-3.1-fast-generate-preview"
export const VIDEO_MODEL = VEO_3_1

// ── Text models ──────────────────────────────────────────────────
export const GEMINI_FLASH = "gemini-2.5-flash"

// ── Music models ────────────────────────────────────────────────
export const LYRIA_REALTIME = "models/lyria-realtime-exp"
