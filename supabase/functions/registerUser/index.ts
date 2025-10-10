import { serve } from "std/http";
import { createClient } from "supabase";
import {
	buildCorsHeaders,
	handlePreflight,
	methodNotAllowed,
	unauthorized,
	forbidden,
	badRequest,
	jsonResponse,
	serverError,
	requireAdminUser,
	logger,
	applyRateLimit,
	getBearerToken,
	getClientIp,
	requireApprovedDevice,
	getClientDeviceId,
} from "../_shared/mod.ts";

type RegisterUserPayload = {
	email?: string;
	password?: string;
	db_host?: string;
	db_name?: string;
	db_user?: string;
	db_password?: string;
	company_name?: string | null;
};

const corsHeaders = buildCorsHeaders({ methods: ["POST", "OPTIONS"] });

serve(async (req: Request) => {
	const preflight = handlePreflight(req, corsHeaders);
	if (preflight) {
		return preflight;
	}

	if (req.method !== "POST") {
		return methodNotAllowed(corsHeaders);
	}

	const rateLimitResponse = applyRateLimit(req, corsHeaders, {
		identifier: "registerUser",
		max: 10,
		windowMs: 60_000,
		message: "Muitas tentativas de registrar usuários. Aguarde um instante e tente novamente.",
		keyGenerator: (request) => {
			const ip = getClientIp(request);
			const tokenFragment = getBearerToken(request)?.slice(-16) ?? "anon";
			return `${ip}:${tokenFragment}`;
		},
	});

	if (rateLimitResponse) {
		return rateLimitResponse;
	}

	const token = getBearerToken(req);
	if (!token) {
		return unauthorized("Missing or invalid Authorization header", corsHeaders);
	}

	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
	const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

	if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
		logger.error("Missing Supabase environment variables for registerUser function", {
			supabaseUrlPresent: Boolean(supabaseUrl),
			supabaseAnonPresent: Boolean(supabaseAnonKey),
			supabaseServiceRolePresent: Boolean(supabaseServiceRoleKey),
		});
		return serverError("Service misconfigured", corsHeaders);
	}

	try {
		let adminUser: Awaited<ReturnType<typeof requireAdminUser>>;
		try {
			adminUser = await requireAdminUser(token, { action: "registrar usuários" });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Acesso negado.";
			if (message.includes("não autenticado")) {
				return unauthorized(message, corsHeaders);
			}
			return forbidden(message, corsHeaders);
		}

		const clientDeviceId = getClientDeviceId(req);
		try {
			await requireApprovedDevice(adminUser.id, clientDeviceId);
		} catch (deviceError) {
			const message = deviceError instanceof Error ? deviceError.message : "Dispositivo não autorizado.";
			return forbidden(message, corsHeaders);
		}

		let payload: RegisterUserPayload;
		try {
			payload = (await req.json()) as RegisterUserPayload;
		} catch (_err) {
			return badRequest("Invalid JSON payload", corsHeaders);
		}

		const email = payload.email?.trim();
		const password = payload.password?.trim();
		const dbHost = payload.db_host?.trim();
		const dbName = payload.db_name?.trim();
		const dbUser = payload.db_user?.trim();
		const dbPassword = payload.db_password?.trim();
		const companyName = payload.company_name?.trim();

		if (!email || !password || !dbHost || !dbName || !dbUser || !dbPassword) {
			return badRequest("Missing required fields", corsHeaders);
		}

		const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

		const { data: createdUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
			email,
			password,
			email_confirm: true,
			user_metadata: {
				role: "client",
			},
		});

		if (createUserError || !createdUser?.user) {
			return badRequest(createUserError?.message ?? "Failed to create auth user", corsHeaders);
		}

		const newUserId = createdUser.user.id;
		const { error: insertError } = await supabaseAdmin.from("db_info").insert({
			id_user: newUserId,
			db_host: dbHost,
			db_name: dbName,
			db_user: dbUser,
			db_password: dbPassword,
			company_name: companyName ? companyName : null,
		});

		if (insertError) {
			logger.error("Failed to insert into db_info", {
				error: insertError.message,
				hint: insertError.hint,
				code: insertError.code,
				details: insertError.details,
			});
			try {
				await supabaseAdmin.auth.admin.deleteUser(newUserId);
			} catch (cleanupError) {
				logger.error("Failed to rollback auth user after insert error", {
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
				});
			}

			return serverError("Failed to persist user data", corsHeaders);
		}

		return jsonResponse({ message: "Usuário criado com sucesso", userId: newUserId }, {
			status: 201,
			corsHeaders,
		});
	} catch (error) {
		logger.error("registerUser edge function error", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		return serverError("Unexpected server error", corsHeaders);
	}
});
