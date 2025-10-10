import { createClient, type User } from "supabase";
import { logger } from "./logging.ts";

export function getBearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization") ?? request.headers.get("authorization");
	if (!header) {
		return null;
	}
	const matches = header.match(/^Bearer\s+(.+)$/i);
	return matches?.[1]?.trim() ?? null;
}

export type RequireAdminOptions = {
	requiredRole?: string;
	action?: string;
};

export async function requireAuthenticatedUser(token: string): Promise<User> {
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

	if (!supabaseUrl || !supabaseAnonKey) {
		logger.error("Supabase credentials missing for auth check", {
			supabaseUrlPresent: Boolean(supabaseUrl),
			supabaseAnonPresent: Boolean(supabaseAnonKey),
		});
		throw new Error("Serviço mal configurado. Variáveis de ambiente do Supabase ausentes.");
	}

	const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
		global: {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		},
	});

	const { data, error } = await supabaseClient.auth.getUser(token);
	if (error || !data.user) {
		logger.warn("Falha ao obter usuário autenticado", {
			error: error?.message ?? null,
		});
		throw new Error("Usuário não autenticado ou inválido.");
	}

	return data.user;
}

export function extractRoles(user: User): Set<string> {
	const roleSources = [
		user.app_metadata?.role,
		user.user_metadata?.role,
		user.app_metadata?.roles,
		user.user_metadata?.roles,
	];

	const roles = new Set<string>(["authenticated"]);
	for (const source of roleSources) {
		if (!source) continue;
		if (typeof source === "string") {
			roles.add(source);
			continue;
		}
		if (Array.isArray(source)) {
			for (const item of source) {
				if (typeof item === "string") {
					roles.add(item);
				}
			}
		}
	}

	return roles;
}

export async function requireAdminUser(
	token: string,
	options: RequireAdminOptions = {},
): Promise<User> {
	const { requiredRole = "admin", action = "executar esta ação" } = options;
	const user = await requireAuthenticatedUser(token);
	const roles = extractRoles(user);

	if (!roles.has(requiredRole)) {
		logger.warn("Usuário sem permissão", {
			requiredRole,
			roles: Array.from(roles),
			action,
			userId: user.id,
		});
		throw new Error(`Acesso negado. Apenas usuários com perfil '${requiredRole}' podem ${action}.`);
	}

	return user;
}
