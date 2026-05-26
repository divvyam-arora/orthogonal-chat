import { tool } from 'ai'
import { z } from 'zod'
import { orthogonal } from './orthogonal'
import { CircuitOpenError } from './orthogonal-resilience'
import {
  buildEndpointSpec,
  buildOrchestrationHint,
  validateRunInputs,
  type EndpointSpec,
} from './orchestration'

export type ToolExecMeta = {
  latencyMs: number
  costUsd: number
  cacheHit: boolean
}

// We attach a per-call metadata side-channel via the tool result envelope so the UI can render it.
export const buildTools = (opts?: {
  inspectedEndpoints?: Iterable<[string, string]>
  endpointSpecs?: Iterable<EndpointSpec>
}) => {
  // Tolerant key: case-insensitive, ignore trailing slash. Prevents redundant get_details
  // calls when the model alternates between e.g. "/Search" and "/search/".
  const endpointKey = (api: string, path: string) =>
    `${api.trim().toLowerCase()}::${path.trim().replace(/\/+$/, '').toLowerCase()}`
  const inspectedEndpoints = new Set<string>()
  const endpointSpecs = new Map<string, EndpointSpec>()
  if (opts?.inspectedEndpoints) {
    for (const [api, path] of opts.inspectedEndpoints) {
      if (api && path) inspectedEndpoints.add(endpointKey(api, path))
    }
  }
  if (opts?.endpointSpecs) {
    for (const spec of opts.endpointSpecs) {
      endpointSpecs.set(endpointKey(spec.api, spec.path), spec)
    }
  }

  return {
    search_apis: tool({
      description:
        'Search the Orthogonal API catalog (free). Start with ONE query matching the user goal. ' +
        'Call again only if no suitable api/path appears in the top results.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Natural-language description of the capability to find'),
        limit: z.number().int().min(1).max(8).optional(),
      }),
      execute: async ({ query, limit }) => {
        const t0 = Date.now()
        const capped = Math.min(limit ?? 6, 6)
        try {
          const out = await orthogonal.searchApis(query, capped)
          return {
            ok: true,
            results: out.results,
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: !!out.cache_hit },
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'unknown error'
          return {
            ok: false,
            error: {
              message,
              code: err instanceof CircuitOpenError ? 'circuit_open' : undefined,
            },
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
          }
        }
      },
    }),

    get_details: tool({
      description:
        'Get required/optional parameters for an endpoint before calling run_api. Required before run_api. ' +
        'Read orchestration.requiredFields — decide if user input is enough or a web-search step is needed first.',
      inputSchema: z.object({
        api: z.string().min(1).describe('API slug from search_apis, e.g. "sixtyfour"'),
        path: z.string().min(1).describe('Endpoint path from search_apis, e.g. "/enrich-lead"'),
      }),
      execute: async ({ api, path }) => {
        const t0 = Date.now()
        try {
          const out = await orthogonal.getDetails(api, path)
          const key = endpointKey(out.api, out.path)
          inspectedEndpoints.add(key)
          const spec = buildEndpointSpec(out.api, out.path, out.bodyParams, out.queryParams)
          endpointSpecs.set(key, spec)
          const orchestration = buildOrchestrationHint(spec)
          return {
            ok: true,
            api: out.api,
            path: out.path,
            method: out.method,
            description: out.description,
            bodyParams: out.bodyParams,
            queryParams: out.queryParams,
            orchestration,
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: !!out.cache_hit },
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'unknown error'
          return {
            ok: false,
            error: {
              message,
              code: err instanceof CircuitOpenError ? 'circuit_open' : undefined,
            },
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
          }
        }
      },
    }),

    run_api: tool({
      description:
        'Execute a request against an API. Requires get_details first. ' +
        'If blocked for missing/suspicious inputs, follow suggestedNextSteps (often a simpler API answers the question).',
      inputSchema: z.object({
        api: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        body: z.record(z.string(), z.unknown()).optional(),
        query: z.record(z.string(), z.unknown()).optional(),
        // Backward compatibility for earlier prompt/schema versions:
        api_id: z.string().min(1).optional(),
        endpoint: z.string().min(1).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async ({ api, path, body, query, api_id, endpoint, params }) => {
        const t0 = Date.now()
        try {
          const apiName = api ?? api_id
          const apiPath = path ?? endpoint
          const apiBody = body ?? params ?? {}
          const apiQuery = query ?? {}
          if (!apiName || !apiPath) {
            throw new Error('run_api requires api/path (or api_id/endpoint)')
          }
          const key = endpointKey(apiName, apiPath)
          if (!inspectedEndpoints.has(key)) {
            throw new Error(
              `run_api blocked: call get_details first for api="${apiName}" path="${apiPath}", then retry with required body/query fields.`,
            )
          }

          const spec = endpointSpecs.get(key)
          if (spec) {
            const validation = validateRunInputs(spec, apiBody, apiQuery)
            if (!validation.ok) {
              return {
                ok: false,
                error: {
                  code: validation.code,
                  message: validation.message,
                  missingFields: validation.missingFields,
                  suspiciousFields: validation.suspiciousFields,
                  suggestedNextSteps: validation.suggestedNextSteps,
                },
                _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
              }
            }
          }

          const out = await orthogonal.runApi(apiName, apiPath, apiBody, apiQuery)
          return {
            ok: true,
            status: out.status,
            body: out.body,
            _meta: {
              latencyMs: out.latency_ms ?? Date.now() - t0,
              costUsd: out.cost_usd ?? 0,
              cacheHit: !!out.cache_hit,
            },
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'unknown error'
          return {
            ok: false,
            error: {
              message,
              code: err instanceof CircuitOpenError ? 'circuit_open' : undefined,
            },
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
          }
        }
      },
    }),
  }
}
