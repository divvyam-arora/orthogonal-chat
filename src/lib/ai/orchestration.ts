export type EndpointParam = {
  name: string
  required: boolean
  type?: string
  description?: string
}

export type EndpointSpec = {
  api: string
  path: string
  bodyParams: EndpointParam[]
  queryParams: EndpointParam[]
  requiredFields: EndpointParam[]
}

export type RunValidationResult =
  | { ok: true }
  | {
      ok: false
      code: 'missing_prerequisites' | 'suspicious_inputs'
      message: string
      missingFields: string[]
      suspiciousFields: Array<{ field: string; value: unknown; reason: string }>
      suggestedNextSteps: string[]
    }

const IDENTIFIER_FIELD_RE =
  /(?:^|[_-])(?:domain|url|uri|website|site|homepage|linkedin|email|handle|slug)(?:$|[_-])|^(?:domain|url|uri|website|site|homepage|linkedin|email|handle|slug)$/i

const DISCOVERY_SEARCH_QUERIES = [
  'web search google',
  'google search serp',
  'web search results',
]

/** Normalize Orthogonal bodyParams/queryParams into a flat param list. */
export function parseParamList(raw: unknown): EndpointParam[] {
  if (!raw) return []
  const items = Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>).map(([name, v]) => ({ name, ...(typeof v === 'object' && v ? (v as object) : {}) })) : []
  const out: EndpointParam[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name : typeof o.key === 'string' ? o.key : null
    if (!name) continue
    out.push({
      name,
      required: o.required === true || o.optional === false,
      type: typeof o.type === 'string' ? o.type : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
    })
  }
  return out
}

export function buildEndpointSpec(api: string, path: string, bodyParams: unknown, queryParams: unknown): EndpointSpec {
  const body = parseParamList(bodyParams)
  const query = parseParamList(queryParams)
  const requiredFields = [...body, ...query].filter((p) => p.required)
  return { api, path, bodyParams: body, queryParams: query, requiredFields }
}

export function isIdentifierField(name: string): boolean {
  return IDENTIFIER_FIELD_RE.test(name)
}

/** True if value plausibly satisfies a domain/url/email-style required field. */
export function looksLikeStructuredIdentifier(name: string, value: unknown): boolean {
  if (value == null) return false
  const s = String(value).trim()
  if (!s) return false

  const lowerName = name.toLowerCase()
  if (lowerName.includes('email')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
  }
  if (lowerName.includes('linkedin')) {
    return /linkedin\.com/i.test(s)
  }
  if (lowerName.includes('url') || lowerName.includes('uri') || lowerName.includes('website') || lowerName.includes('homepage')) {
    return /^https?:\/\//i.test(s) || /\.\w{2,}/.test(s)
  }
  if (lowerName.includes('domain') || lowerName.includes('site')) {
    // domain: stripe.com — not "Stripe" or "stripe company"
    if (/\s/.test(s)) return false
    return /\.\w{2,}/.test(s) || /^[a-z0-9-]+\.[a-z]{2,}$/i.test(s)
  }
  return s.length >= 2
}

function getFieldValue(name: string, body: Record<string, unknown>, query: Record<string, unknown>): unknown {
  if (name in body) return body[name]
  if (name in query) return query[name]
  // Nested body paths like lead_info.company_domain
  for (const [, v] of Object.entries(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && name in (v as Record<string, unknown>)) {
      return (v as Record<string, unknown>)[name]
    }
  }
  return undefined
}

export function validateRunInputs(
  spec: EndpointSpec,
  body: Record<string, unknown>,
  query: Record<string, unknown>,
): RunValidationResult {
  const missingFields: string[] = []
  const suspiciousFields: Array<{ field: string; value: unknown; reason: string }> = []

  for (const param of spec.requiredFields) {
    const value = getFieldValue(param.name, body, query)
    if (value == null || String(value).trim() === '') {
      missingFields.push(param.name)
      continue
    }
    if (isIdentifierField(param.name) && !looksLikeStructuredIdentifier(param.name, value)) {
      suspiciousFields.push({
        field: param.name,
        value,
        reason: `Required identifier "${param.name}" looks like a bare name, not a domain/url/email. Resolve it first (usually via web search).`,
      })
    }
  }

  if (missingFields.length === 0 && suspiciousFields.length === 0) {
    return { ok: true }
  }

  const suggestedNextSteps = buildPrerequisiteSteps(spec, missingFields, suspiciousFields)

  if (suspiciousFields.length > 0) {
    const fieldList = suspiciousFields.map((s) => `${s.field}=${JSON.stringify(s.value)}`).join(', ')
    return {
      ok: false,
      code: 'suspicious_inputs',
      message:
        `run_api would fail: ${spec.api}${spec.path} expects structured identifiers but received name-like values (${fieldList}). ` +
        `Re-plan: a simpler API (like web search) may answer the user's question directly in one call. Otherwise resolve the identifiers first.`,
      missingFields,
      suspiciousFields,
      suggestedNextSteps,
    }
  }

  return {
    ok: false,
    code: 'missing_prerequisites',
    message:
      `run_api would fail: ${spec.api}${spec.path} is missing required fields (${missingFields.join(', ')}). ` +
      `Pick the cheapest option below.`,
    missingFields,
    suspiciousFields,
    suggestedNextSteps,
  }
}

export function buildPrerequisiteSteps(
  spec: EndpointSpec,
  missingFields: string[],
  suspiciousFields: Array<{ field: string; value: unknown; reason: string }>,
): string[] {
  const needs = [...missingFields, ...suspiciousFields.map((s) => s.field)]
  // Options are listed cheapest-first. The model picks based on what the user actually wants.
  return [
    `Option A (often cheapest): search_apis for a more direct API that answers the user's question without needing ${needs.join(', ') || 'these identifiers'}. A web-search or lookup endpoint may answer in a single run_api call.`,
    `Option B: search_apis("${DISCOVERY_SEARCH_QUERIES[0]}") → run that endpoint to resolve ${needs.join(', ') || 'identifiers'} → then return to ${spec.api}${spec.path} with the resolved values.`,
    `Option C: ask the user for ${needs.join(', ') || 'the missing identifiers'} directly.`,
  ]
}

export function buildOrchestrationHint(spec: EndpointSpec): {
  requiredFields: Array<{ name: string; required: boolean; type?: string; description?: string; isIdentifier: boolean }>
  hasIdentifierRequirement: boolean
  fallbackSearchQueries: string[]
  hint: string
} {
  const identifierRequired = spec.requiredFields.some((p) => isIdentifierField(p.name))

  let hint: string
  if (identifierRequired) {
    hint =
      'Required identifiers (domain/URL/email/LinkedIn) detected. If the user already supplied them, proceed. ' +
      'If not, decide based on the user\'s actual question: for quick factual answers, prefer a single web-search API call. ' +
      'Only chain (web-search → this endpoint) when the user explicitly wants the structured output this endpoint produces.'
  } else if (spec.requiredFields.length > 0) {
    hint = 'Check user input against requiredFields. If anything is missing, prefer a simpler API or ask the user.'
  } else {
    hint = 'No required fields — should run on user input alone.'
  }

  return {
    requiredFields: spec.requiredFields.map((p) => ({
      name: p.name,
      required: p.required,
      type: p.type,
      description: p.description,
      isIdentifier: isIdentifierField(p.name),
    })),
    hasIdentifierRequirement: identifierRequired,
    fallbackSearchQueries: DISCOVERY_SEARCH_QUERIES,
    hint,
  }
}
