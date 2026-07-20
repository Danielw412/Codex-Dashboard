import fs from 'node:fs';
import path from 'node:path';
import type { TokenUsage } from './types.js';

interface LongContextRule {
  thresholdTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
}

export interface ModelPricing {
  id: string;
  aliases: string[];
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  longContext?: LongContextRule;
}

interface PricingConfig {
  updatedAt: string;
  currency: string;
  models: ModelPricing[];
}

let cachedConfig: PricingConfig | null = null;

export function loadPricingConfig(): PricingConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.resolve(
    process.cwd(),
    process.env.PRICING_CONFIG ?? 'config/pricing.json'
  );
  cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PricingConfig;
  return cachedConfig;
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

export function findPricing(model: string): ModelPricing | null {
  const normalized = normalizeModelName(model);
  const config = loadPricingConfig();

  const exact = config.models.find((entry) =>
    [entry.id, ...entry.aliases].some((alias) => normalizeModelName(alias) === normalized)
  );
  if (exact) return exact;

  // Snapshot model IDs usually append a date. Match the longest alias prefix.
  const candidates = config.models
    .flatMap((entry) => [entry.id, ...entry.aliases].map((alias) => ({ entry, alias })))
    .filter(({ alias }) => normalized.startsWith(`${normalizeModelName(alias)}-`))
    .sort((a, b) => b.alias.length - a.alias.length);
  return candidates[0]?.entry ?? null;
}

export function estimateUsageCost(model: string, usage: TokenUsage): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;

  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  let inputCost =
    (uncached * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion) /
    1_000_000;
  let outputCost = (usage.outputTokens * pricing.outputPerMillion) / 1_000_000;

  // Long-context pricing is applied per upstream request. This function is used on
  // individual token events, not cumulative thread totals.
  if (pricing.longContext && usage.inputTokens > pricing.longContext.thresholdTokens) {
    inputCost *= pricing.longContext.inputMultiplier;
    outputCost *= pricing.longContext.outputMultiplier;
  }

  return inputCost + outputCost;
}
