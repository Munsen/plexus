import type { ProviderPerformanceData, UsageRecord } from './api';

/**
 * Telemetry labels that are treated as "unset". Providers and models sometimes
 * report placeholder strings instead of null, so we normalise these away.
 */
export const PLACEHOLDER_LABELS: ReadonlySet<string> = new Set([
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
]);

/**
 * Strips whitespace and filters out placeholder telemetry labels.
 * Returns an empty string for any value that is null, undefined, blank,
 * or matches a known placeholder (e.g. "unknown", "n/a", "null").
 */
export const normalizeLabel = (value: string | null | undefined): string => {
  const normalized = value?.trim();
  if (!normalized) {
    return '';
  }

  if (PLACEHOLDER_LABELS.has(normalized.toLowerCase())) {
    return '';
  }

  return normalized;
};

/**
 * Returns the display-friendly model name for a provider performance row.
 * Prefers `model_display_name` (from LEFT JOIN with provider_models),
 * then `target_model`, then raw `model`.
 */
export const performanceModelLabel = (
  row: Pick<ProviderPerformanceData, 'model_display_name' | 'target_model' | 'model'>
): string => row.model_display_name || row.target_model || row.model;

/**
 * Returns the "provider/model" label for a provider performance row.
 * When a target model is present, formats as "provider/modelLabel";
 * otherwise returns just the provider name.
 */
export const performanceRowLabel = (
  row: Pick<ProviderPerformanceData, 'provider' | 'model_display_name' | 'target_model' | 'model'>
): string => {
  const modelLabel = performanceModelLabel(row);
  return row.target_model ? `${row.provider}/${modelLabel}` : row.provider;
};

/**
 * Aggregated statistics for a single entity (provider or model).
 * Used by the "stats" card and its expanded modal view.
 *
 * All averages (latency, TTFT, TPS) are arithmetic means computed from the
 * total running sum divided by the request count for that entity.
 */
export interface EntityStats {
  /** Display name of the provider or model */
  name: string;
  /** Total number of requests routed to this entity in the live window */
  requests: number;
  /** Number of requests that did NOT have responseStatus === 'success' */
  errors: number;
  /** Percentage of successful requests: ((requests - errors) / requests) * 100 */
  successRate: number;
  /** Sum of all token types (input + output + cached + cache-write) */
  tokens: number;
  /** Cumulative cost in USD for all requests to this entity */
  cost: number;
  /** Mean end-to-end latency (ms) across all requests */
  avgLatency: number;
  /** Mean Time To First Token (ms) across all requests */
  avgTtft: number;
  /** Mean tokens-per-second throughput across all requests */
  avgTps: number;
}

/**
 * Resolves display labels for UsageRecord fields (provider, model) and
 * computes aggregated entity statistics.
 *
 * Model labels prefer `request.selectedModelDisplayName` (resolved at read-time via LEFT JOIN
 * with provider_models, or in-memory from the dispatcher) over the raw
 * `selectedModelName`. When `selectedModelDisplayName` is absent, `selectedModelName` is
 * returned as-is. `incomingModelAlias` is always returned as-is because aliases
 * are user-facing identifiers, not model IDs.
 */
export class UsageRecordLabeler {
  /**
   * Derives a display label for the provider of a request.
   * Falls back to "Failed Request" if the request errored before a provider was
   * resolved, or "Unresolved Provider" if the provider field is simply absent.
   */
  providerLabel(request: UsageRecord): string {
    const provider = normalizeLabel(request.provider);
    if (provider) {
      return provider;
    }

    const status = (request.responseStatus || '').toLowerCase();
    if (status && status !== 'success') {
      return 'Failed Request';
    }

    return 'Unresolved Provider';
  }

  /**
   * Derives a display label for the model used in a request.
   *
   * Prefers `selectedModelDisplayName` (resolved by the backend via LEFT JOIN or dispatcher)
   * over `selectedModelName`. When neither is available, falls back to
   * `incomingModelAlias`, then to error/placeholder strings.
   */
  modelLabel(request: UsageRecord): string {
    const selectedModelDisplayName = normalizeLabel(request.selectedModelDisplayName);
    if (selectedModelDisplayName) {
      return selectedModelDisplayName;
    }

    const selected = normalizeLabel(request.selectedModelName);
    if (selected) {
      return selected;
    }

    const alias = normalizeLabel(request.incomingModelAlias);
    if (alias) {
      return alias;
    }

    const status = (request.responseStatus || '').toLowerCase();
    if (status && status !== 'success') {
      return 'Failed Before Model Selection';
    }

    return 'Unresolved Model';
  }

  /**
   * Groups an array of usage records by a specified entity dimension (provider
   * or model), then computes aggregate statistics for each group.
   *
   * Algorithm:
   * 1. Iterate over all requests, resolving each to a string key via
   *    providerLabel or modelLabel.
   * 2. Accumulate running totals in a Map<string, accumulators> -- using a Map
   *    rather than a plain object for O(1) key lookup and to avoid prototype
   *    pollution with arbitrary provider/model name strings.
   * 3. Convert the Map entries into EntityStats objects, computing averages by
   *    dividing cumulative sums by the request count.
   * 4. Sort descending by request count and return only the top 5.
   *
   * @param requests - The filtered array of live UsageRecords
   * @param entityType - Whether to group by 'provider' or 'model'
   * @returns Top 5 entities sorted by descending request count
   */
  aggregateByEntity(requests: UsageRecord[], entityType: 'provider' | 'model'): EntityStats[] {
    const grouped = new Map<
      string,
      {
        requests: number;
        errors: number;
        tokens: number;
        cost: number;
        latency: number;
        ttft: number;
        tps: number;
      }
    >();

    requests.forEach((request) => {
      const key =
        entityType === 'provider' ? this.providerLabel(request) : this.modelLabel(request);

      const existing = grouped.get(key) || {
        requests: 0,
        errors: 0,
        tokens: 0,
        cost: 0,
        latency: 0,
        ttft: 0,
        tps: 0,
      };

      existing.requests++;
      if ((request.responseStatus || '').toLowerCase() !== 'success') existing.errors++;
      existing.tokens +=
        (request.tokensInput || 0) +
        (request.tokensOutput || 0) +
        (request.tokensCached || 0) +
        (request.tokensCacheWrite || 0);
      existing.cost += request.costTotal || 0;
      existing.latency += request.durationMs || 0;
      existing.ttft += request.ttftMs || 0;
      existing.tps += request.tokensPerSec || 0;
      grouped.set(key, existing);
    });

    return Array.from(grouped.entries())
      .map(([name, data]) => ({
        name,
        requests: data.requests,
        errors: data.errors,
        successRate: data.requests > 0 ? ((data.requests - data.errors) / data.requests) * 100 : 0,
        tokens: data.tokens,
        cost: data.cost,
        avgLatency: data.requests > 0 ? data.latency / data.requests : 0,
        avgTtft: data.requests > 0 ? data.ttft / data.requests : 0,
        avgTps: data.requests > 0 ? data.tps / data.requests : 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 5);
  }
}
