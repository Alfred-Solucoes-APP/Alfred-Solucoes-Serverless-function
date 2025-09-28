import { serve } from "std/http";
import { createClient } from "supabase";

type RegisterUserPayload = {
	email?: string;
	password?: string;
	db_host?: string;
	db_name?: string;
	db_user?: string;
	db_password?: string;
	company_name?: string | null;
};

const corsHeaders = {
	"Access-Control-Allow-Origin": Deno.env.get("FUNCTIONS_ALLOWED_ORIGIN") ?? "*",
	"Access-Control-Allow-Headers":
		"authorization, content-type, apikey, x-client-info, x-client-version",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: corsHeaders });
	}

	if (req.method !== "POST") {
		return new Response(JSON.stringify({ error: "Method not allowed" }), {
			status: 405,
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	}

	const authHeader = req.headers.get("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return new Response(JSON.stringify({ error: "Missing or invalid Authorization header" }), {
			status: 401,
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	}

	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
	const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

	if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
		console.error("Missing Supabase environment variables for registerUser function", {
			supabaseUrlPresent: Boolean(supabaseUrl),
			supabaseAnonPresent: Boolean(supabaseAnonKey),
			supabaseServiceRolePresent: Boolean(supabaseServiceRoleKey),
		});
		return new Response(JSON.stringify({ error: "Service misconfigured" }), {
			status: 500,
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	}

	try {
		const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
			global: {
				headers: {
					Authorization: authHeader,
				},
			},
		});

		const {
			data: userData,
			error: getUserError,
		} = await supabaseClient.auth.getUser();

		if (getUserError || !userData?.user) {
			return new Response(JSON.stringify({ error: "Invalid token" }), {
				status: 401,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		const roleFromUserMetadata = (userData.user.user_metadata as Record<string, unknown> | null | undefined)?.role;
		const roleFromAppMetadata = (userData.user.app_metadata as Record<string, unknown> | null | undefined)?.role;
		const role = (roleFromUserMetadata ?? roleFromAppMetadata) as string | undefined;

		if (role !== "admin") {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		let payload: RegisterUserPayload;
		try {
			payload = (await req.json()) as RegisterUserPayload;
		} catch (_err) {
			return new Response(JSON.stringify({ error: "Invalid JSON payload" }), {
				status: 400,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
		}

		const email = payload.email?.trim();
		const password = payload.password?.trim();
		const dbHost = payload.db_host?.trim();
		const dbName = payload.db_name?.trim();
		const dbUser = payload.db_user?.trim();
		const dbPassword = payload.db_password?.trim();
		const companyName = payload.company_name?.trim();

		if (!email || !password || !dbHost || !dbName || !dbUser || !dbPassword) {
			return new Response(JSON.stringify({ error: "Missing required fields" }), {
				status: 400,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			});
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
			return new Response(
				JSON.stringify({ error: createUserError?.message ?? "Failed to create auth user" }),
				{
					status: 400,
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				},
			);
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
			console.error("Failed to insert into users_master", {
				error: insertError.message,
				hint: insertError.hint,
				code: insertError.code,
				details: insertError.details,
			});
			try {
				await supabaseAdmin.auth.admin.deleteUser(newUserId);
			} catch (cleanupError) {
				console.error("Failed to rollback auth user after insert error", {
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					stack: cleanupError instanceof Error ? cleanupError.stack : undefined,
				});
			}

			return new Response(
				JSON.stringify({
					error: "Failed to persist user data",
					code: insertError.code ?? null,
					details: insertError.details ?? null,
					hint: insertError.hint ?? null,
				}),
				{
					status: 500,
					headers: { ...corsHeaders, "Content-Type": "application/json" },
				},
			);
		}

		return new Response(
			JSON.stringify({ message: "Usuário criado com sucesso", userId: newUserId }),
			{
				status: 201,
				headers: { ...corsHeaders, "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("registerUser edge function error", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		return new Response(JSON.stringify({ error: "Unexpected server error" }), {
			status: 500,
			headers: { ...corsHeaders, "Content-Type": "application/json" },
		});
	}
});
