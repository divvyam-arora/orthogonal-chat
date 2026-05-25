import { tool } from 'ai'
import { z } from 'zod'
import { orthogonal } from './orthogonal'

export type ToolExecMeta = {
  latencyMs: number
  costUsd: number
  cacheHit: boolean
}

// We attach a per-call metadata side-channel via the tool result envelope so the UI can render it.
export const buildTools = () => {
  const inspectedEndpoints = new Set<string>()
  const endpointKey = (api: string, path: string) => `${api.trim().toLowerCase()}::${path.trim()}`

  return {
    search_apis: tool({
    description: 'Search the Orthogonal API catalog by natural-language query. Use first to find a relevant API.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Natural-language description of what the user wants to do'),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    execute: async ({ query, limit }) => {
      const t0 = Date.now()
      try {
        const out = await orthogonal.searchApis(query, limit)
        return {
          ok: true,
          results: out.results,
          _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'unknown error'
        return {
          ok: false,
          error: { message },
          _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
        }
      }
    },
    }),

    get_details: tool({
      description:
        'Get required/optional parameters for an endpoint before calling run_api. Use after search_apis and before run_api.',
      inputSchema: z.object({
        api: z.string().min(1).describe('API slug from search_apis, e.g. "sixtyfour"'),
        path: z.string().min(1).describe('Endpoint path from search_apis, e.g. "/enrich-lead"'),
      }),
      execute: async ({ api, path }) => {
        const t0 = Date.now()
        try {
          const out = await orthogonal.getDetails(api, path)
          inspectedEndpoints.add(endpointKey(out.api, out.path))
          return {
            ok: true,
            api: out.api,
            path: out.path,
            method: out.method,
            description: out.description,
            bodyParams: out.bodyParams,
            queryParams: out.queryParams,
            details: out.raw,
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'unknown error'
          return {
            ok: false,
            error: { message },
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
          }
        }
      },
    }),

    run_api: tool({
      description:
        'Execute a request against an API discovered via search_apis. Prefer using get_details first. Supports body and query params.',
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
            error: { message },
            _meta: { latencyMs: Date.now() - t0, costUsd: 0, cacheHit: false },
          }
        }
      },
    }),
  }
}
