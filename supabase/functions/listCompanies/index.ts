import { serve } from "std/http";
import { createClient } from "supabase";

type CompanyRow = {
  id_user: string;
  company_name: string | null;
  db_name: string | null;
};

async function requireAdminUser(token: string) {
  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    }
  );

  const { data, error } = await supabaseClient.auth.getUser(token);
  if (error || !data.user) {
    throw new Error("Usuário não autenticado ou inválido.");
  }

  const roleSources = [
    data.user.app_metadata?.role,
    data.user.user_metadata?.role,
    data.user.app_metadata?.roles,
    data.user.user_metadata?.roles,
  ];

  const roles = new Set<string>(["authenticated"]);
  for (const source of roleSources) {
    if (!source) continue;
    if (typeof source === "string") {
      roles.add(source);
    } else if (Array.isArray(source)) {
      for (const item of source) {
        if (typeof item === "string") {
          roles.add(item);
        }
      }
    }
  }

  if (!roles.has("admin")) {
    throw new Error("Acesso negado. Apenas administradores podem listar empresas.");
  }

  return data.user;
}

serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": Deno.env.get("FUNCTIONS_ALLOWED_ORIGIN") ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-client-version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Authorization header ausente." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.substring("Bearer ".length);
    await requireAdminUser(token);

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

    return new Response(
      JSON.stringify({ companies }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Erro na função listCompanies", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message ?? "Erro inesperado." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
