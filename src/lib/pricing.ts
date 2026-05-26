export type ModelPricing = { inputPer1M: number; outputPer1M: number }

export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-4-7': { inputPer1M: 15, outputPer1M: 75 },
  'claude-haiku-4-5': { inputPer1M: 0.8, outputPer1M: 4 },
}

export function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model]
  if (!p) return 0
  return (inputTokens * p.inputPer1M + outputTokens * p.outputPer1M) / 1_000_000
}
