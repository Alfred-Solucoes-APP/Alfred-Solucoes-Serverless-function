import { serve } from "std/http";
import { createClient } from "supabase";
import {
  buildCorsHeaders,
  handlePreflight,
  methodNotAllowed,
  unauthorized,
  forbidden,
  jsonResponse,
  serverError,
  requireAdminUser,
  logger,
} from "../_shared/mod.ts";

type CompanyRow = {
  id_user: string;
  company_name: string | null;
  db_name: string | null;
};

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders({ methods: ["GET", "POST", "OPTIONS"] });

  const preflight = handlePreflight(req, corsHeaders);
  if (preflight) {
    return preflight;
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return methodNotAllowed(corsHeaders);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return unauthorized("Authorization header ausente.", corsHeaders);
    }

    const token = authHeader.substring("Bearer ".length);
    try {
      await requireAdminUser(token, { action: "listar empresas" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Acesso negado.";
      if (message.includes("não autenticado")) {
        return unauthorized(message, corsHeaders);
      }
      return forbidden(message, corsHeaders);
    }

    const supabaseService = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data, error } = await supabaseService
      .from("db_info")
      .select("id_user, company_name, db_name")
      .order("company_name", { ascending: true });

    if (error) {
      throw new Error(error.message ?? "Não foi possível carregar as empresas.");
    }

    const companies = Array.isArray(data) ? (data as CompanyRow[]) : [];

    return jsonResponse({ companies }, { status: 200, corsHeaders });
  } catch (error) {
    logger.error("Erro na função listCompanies", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return serverError((error as Error).message ?? "Erro inesperado.", corsHeaders);
  }
});
