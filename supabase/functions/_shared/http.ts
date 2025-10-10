type HeadersRecord = Record<string, string>;

export type CorsOptions = {
	methods?: string[];
	allowedHeaders?: string;
	origin?: string;
};

export function buildCorsHeaders(options: CorsOptions = {}): HeadersRecord {
	const origin = options.origin ?? Deno.env.get("FUNCTIONS_ALLOWED_ORIGIN") ?? "*";
	const methods = options.methods ?? ["POST", "OPTIONS"];
	const allowedHeaders =
		options.allowedHeaders ?? "authorization, content-type, apikey, x-client-info, x-client-version";

	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Headers": allowedHeaders,
		"Access-Control-Allow-Methods": methods.join(", "),
	};
}

export function handlePreflight(request: Request, corsHeaders: HeadersRecord): Response | null {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	return null;
}

export function methodNotAllowed(corsHeaders: HeadersRecord): Response {
	return new Response("Method Not Allowed", {
		status: 405,
		headers: { ...corsHeaders, "Content-Type": "text/plain" },
	});
}

export function jsonResponse(
	body: unknown,
	options: { status?: number; corsHeaders?: HeadersRecord; headers?: HeadersRecord } = {},
): Response {
	const status = options.status ?? 200;
	const corsHeaders = options.corsHeaders ?? {};
	const extraHeaders = options.headers ?? {};
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...corsHeaders, ...extraHeaders, "Content-Type": "application/json" },
	});
}

export function badRequest(message: string, corsHeaders: HeadersRecord): Response {
	return jsonResponse({ error: message }, { status: 400, corsHeaders });
}

export function unauthorized(message: string, corsHeaders: HeadersRecord): Response {
	return jsonResponse({ error: message }, { status: 401, corsHeaders });
}

export function forbidden(message: string, corsHeaders: HeadersRecord): Response {
	return jsonResponse({ error: message }, { status: 403, corsHeaders });
}

export function notFound(message: string, corsHeaders: HeadersRecord): Response {
	return jsonResponse({ error: message }, { status: 404, corsHeaders });
}

export function conflict(message: string, corsHeaders: HeadersRecord): Response {
	return jsonResponse({ error: message }, { status: 409, corsHeaders });
}

export function serverError(message: string, corsHeaders: HeadersRecord): Response {
	return jsonResponse({ error: message }, { status: 500, corsHeaders });
}

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

export type RateLimitOptions = {
	identifier?: string;
	windowMs?: number;
	max?: number;
	keyGenerator?: (request: Request) => string | null;
	message?: string;
};

export function getClientIp(request: Request): string {
	const headerCandidates = [
		"x-forwarded-for",
		"cf-connecting-ip",
		"x-real-ip",
		"x-client-ip",
	];

	for (const header of headerCandidates) {
		const value = request.headers.get(header);
		if (value) {
			const first = value.split(",")[0]?.trim();
			if (first) {
				return first;
			}
		}
	}

	return "unknown";
}

export function applyRateLimit(
	request: Request,
	corsHeaders: HeadersRecord,
	options: RateLimitOptions = {},
): Response | null {
	const windowMs = options.windowMs ?? 60_000;
	const max = options.max ?? 60;
	const message = options.message ?? "Limite de requisições excedido.";
	const identifier = options.identifier ?? "global";
	const keyPart = options.keyGenerator ? options.keyGenerator(request) : getClientIp(request);
	const finalKey = keyPart?.trim() && keyPart.trim().length > 0 ? keyPart.trim() : "unknown";
	const bucketKey = `${identifier}:${finalKey}`;
	const now = Date.now();
	const existing = rateLimitBuckets.get(bucketKey);

	if (!existing || existing.resetAt <= now) {
		rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
		return null;
	}

	if (existing.count >= max) {
		const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
		return jsonResponse(
			{ error: message, retryAfterSeconds },
			{ status: 429, corsHeaders, headers: { "Retry-After": String(retryAfterSeconds) } },
		);
	}

	rateLimitBuckets.set(bucketKey, { ...existing, count: existing.count + 1 });
	return null;
}

export type { HeadersRecord };
