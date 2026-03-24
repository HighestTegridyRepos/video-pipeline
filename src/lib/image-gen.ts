import { getGeminiClient, IMAGE_MODEL, NANO_BANANA_2 } from "./gemini"
import { logInfo, logWarn } from "./logger"

const ROUTE = "image-gen"

export interface ImageGenResult {
  imageDataUrl: string
  mimeType: string
  model: string
  prompt: string
}

/**
 * Generate an image using Nano Banana Pro (or specified model).
 * Returns base64 data URL.
 */
export async function generateImage(
  prompt: string,
  model?: string,
): Promise<ImageGenResult> {
  const activeModel = model || IMAGE_MODEL
  const ai = getGeminiClient()

  logInfo(ROUTE, `Generating image with ${activeModel}`, { promptLength: prompt.length })

  const response = await ai.models.generateContent({
    model: activeModel,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseModalities: ["IMAGE", "TEXT"] as unknown as undefined },
  })

  const parts = response.candidates?.[0]?.content?.parts
  if (!parts) {
    throw new Error("Image generation returned no response")
  }

  let imageBase64: string | null = null
  let imageMimeType = "image/png"
  for (const part of parts) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data ?? null
      imageMimeType = part.inlineData.mimeType ?? "image/png"
      break
    }
  }

  if (!imageBase64) {
    throw new Error("Image model did not return an image")
  }

  logInfo(ROUTE, `Image generated successfully`)

  return {
    imageDataUrl: `data:${imageMimeType};base64,${imageBase64}`,
    mimeType: imageMimeType,
    model: activeModel,
    prompt,
  }
}

/**
 * Generate multiple images in parallel. Returns successful results.
 */
export async function generateImages(
  prompts: string[],
  model?: string,
): Promise<ImageGenResult[]> {
  const results = await Promise.allSettled(
    prompts.map(prompt => generateImage(prompt, model))
  )

  const images: ImageGenResult[] = []
  for (const result of results) {
    if (result.status === "fulfilled") {
      images.push(result.value)
    } else {
      logWarn(ROUTE, `Image generation failed: ${result.reason}`)
    }
  }

  return images
}
