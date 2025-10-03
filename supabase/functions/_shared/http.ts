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
	options: { status?: number; corsHeaders?: HeadersRecord } = {},
): Response {
	const status = options.status ?? 200;
	const corsHeaders = options.corsHeaders ?? {};
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...corsHeaders, "Content-Type": "application/json" },
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

export type { HeadersRecord };
