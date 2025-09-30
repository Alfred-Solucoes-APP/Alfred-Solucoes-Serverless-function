import { serve } from "std/http";
import { createClient } from "supabase";
import { Pool } from "postgres";

type JsonRecord = Record<string, unknown>;

type GraphPayload = {
  company_id: string;
  slug: string;
  title?: string | null;
  description?: string | null;
  query_template: string;
  param_schema?: unknown;
  default_params?: unknown;
  result_shape?: unknown;
  allowed_roles?: unknown;
  is_active?: boolean;
};

type DbInfoRow = {
  db_host: string;
  db_name: string;
  db_user: string;
  db_password: string;
  company_name: string | null;
};

function parseJsonField(value: unknown, fieldName: string): JsonRecord | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
      throw new Error("O JSON deve representar um objeto.");
    } catch (error) {
      throw new Error(`Campo '${fieldName}' não contém um JSON válido: ${(error as Error).message}`);
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }

  throw new Error(`Campo '${fieldName}' deve ser um objeto JSON.`);
}

function parseAllowedRoles(value: unknown): string[] {
  const fallbackRoles = ["user", "authenticated"];

  const normalizeRoles = (roles: string[]): string[] => {
    const unique = new Set<string>();
    for (const role of roles) {
      const trimmed = role.trim();
      if (trimmed.length > 0) {
        unique.add(trimmed);
      }
    }

    if (unique.size === 0) {
      for (const fallback of fallbackRoles) {
        unique.add(fallback);
      }
    }

    return Array.from(unique);
  };

  if (value === null || value === undefined || value === "") {
    return [...fallbackRoles];
  }

  if (Array.isArray(value)) {
    const roles = value.map((item) => (typeof item === "string" ? item : String(item)));
    return normalizeRoles(roles);
  }

  if (typeof value === "string") {
    return normalizeRoles(value.split(","));
  }

  return normalizeRoles([String(value)]);
}

function normalizeSlug(slug: string): string {
  const trimmed = slug.trim();
  if (!trimmed) {
    throw new Error("Slug do gráfico é obrigatório.");
  }
  return trimmed.toLowerCase().replace(/\s+/g, "_");
}

function ensureQueryTemplate(template: string): string {
  const normalized = template.trim();
  if (!normalized) {
    throw new Error("Query template é obrigatório.");
  }
  return normalized;
}

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
    throw new Error("Acesso negado. Apenas administradores podem gerenciar gráficos.");
  }

  return data.user;
}

async function getCompanyConnection(companyId: string): Promise<DbInfoRow> {
  const supabaseService = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const { data, error } = await supabaseService
    .from("db_info")
    .select("db_host, db_name, db_user, db_password, company_name")
    .eq("id_user", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message ?? "Erro ao buscar banco do cliente.");
  }

  if (!data) {
    throw new Error("Nenhum banco encontrado para o cliente informado.");
  }

  return data as DbInfoRow;
}

serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": Deno.env.get("FUNCTIONS_ALLOWED_ORIGIN") ?? "*",
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info, x-client-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
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

    let payload: GraphPayload;
    try {
      payload = (await req.json()) as GraphPayload;
    } catch (error) {
      return new Response(JSON.stringify({ error: "JSON inválido no corpo da requisição." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!payload.company_id) {
      return new Response(JSON.stringify({ error: "Campo company_id é obrigatório." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const slug = normalizeSlug(payload.slug ?? "");
    const queryTemplate = ensureQueryTemplate(payload.query_template ?? "");
    const paramSchema = parseJsonField(payload.param_schema, "param_schema");
    const defaultParams = parseJsonField(payload.default_params, "default_params");
    const resultShape = parseJsonField(payload.result_shape, "result_shape");
    const allowedRoles = parseAllowedRoles(payload.allowed_roles);
    const isActive = payload.is_active ?? true;

    const companyDb = await getCompanyConnection(payload.company_id);
    const dbPort = Deno.env.get("CLIENT_DB_DEFAULT_PORT") ?? "5432";

    const connectionUrl = `postgres://${encodeURIComponent(companyDb.db_user)}:${encodeURIComponent(companyDb.db_password)}@${companyDb.db_host}:${dbPort}/${companyDb.db_name}`;

    const pool = new Pool(connectionUrl, 2, true);
    const client = await pool.connect();

    try {
      const existing = await client.queryObject<{ id: number }>(
        {
          text: "SELECT id FROM graficos WHERE slug = $1",
          args: [slug],
        },
      );

      if (existing.rows.length > 0) {
        return new Response(JSON.stringify({ error: "Já existe um gráfico com este slug." }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const insertResult = await client.queryObject<{ id: number }>(
        {
          text: `
            INSERT INTO graficos (
              slug,
              title,
              description,
              query_template,
              param_schema,
              default_params,
              result_shape,
              allowed_roles,
              is_active
            ) VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::jsonb,
              $6::jsonb,
              $7::jsonb,
              $8::text[],
              $9
            )
            RETURNING id
          `,
          args: [
            slug,
            payload.title ?? null,
            payload.description ?? null,
            queryTemplate,
            paramSchema ? JSON.stringify(paramSchema) : null,
            defaultParams ? JSON.stringify(defaultParams) : null,
            resultShape ? JSON.stringify(resultShape) : null,
            allowedRoles,
            isActive,
          ],
        },
      );

      const insertedId = insertResult.rows[0]?.id ?? null;

      return new Response(
        JSON.stringify({
          message: "Gráfico cadastrado com sucesso.",
          graph_id: insertedId,
          slug,
          company_name: companyDb.company_name,
        }),
        {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error("Erro na função manageGraph", error);
    return new Response(JSON.stringify({ error: (error as Error).message ?? "Erro inesperado." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
