import { createClient } from "supabase";
import { logger } from "./logging.ts";

export type DbInfoRow = {
	db_host: string;
	db_name: string;
	db_user: string;
	db_password: string;
	company_name: string | null;
};

export async function getCompanyConnection(companyId: string): Promise<DbInfoRow> {
	const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
	const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

	if (!supabaseUrl || !serviceRoleKey) {
		logger.error("Supabase service role credentials missing for company lookup", {
			supabaseUrlPresent: Boolean(supabaseUrl),
			serviceRolePresent: Boolean(serviceRoleKey),
		});
		throw new Error("Serviço mal configurado. Variáveis de ambiente do Supabase ausentes.");
	}

	const supabaseService = createClient(supabaseUrl, serviceRoleKey);

	const { data, error } = await supabaseService
		.from("db_info")
		.select("db_host, db_name, db_user, db_password, company_name")
		.eq("id_user", companyId)
		.maybeSingle();

	if (error) {
		logger.error("Erro ao buscar banco do cliente", {
			companyId,
			error: error.message,
			code: error.code,
		});
		throw new Error(error.message ?? "Erro ao buscar banco do cliente.");
	}

	if (!data) {
		logger.warn("Banco do cliente não encontrado", { companyId });
		throw new Error("Nenhum banco encontrado para o cliente informado.");
	}

	return data as DbInfoRow;
}
