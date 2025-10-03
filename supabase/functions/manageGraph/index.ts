import { serve } from "std/http";
import { Pool } from "postgres";
import {
  buildCorsHeaders,
  handlePreflight,
  methodNotAllowed,
  unauthorized,
  forbidden,
  conflict,
  jsonResponse,
  serverError,
  badRequest,
  requireAdminUser,
  parseJsonObjectField,
  parseAllowedRoles,
  normalizeSlug,
  ensureNonEmptyString,
  getCompanyConnection,
  logger,
} from "../_shared/mod.ts";

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

const ACTION_LABEL = "gerenciar gráficos";

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders({ methods: ["POST", "OPTIONS"] });

  const preflight = handlePreflight(req, corsHeaders);
  if (preflight) {
    return preflight;
  }

  if (req.method !== "POST") {
    return methodNotAllowed(corsHeaders);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return unauthorized("Authorization header ausente.", corsHeaders);
    }

    const token = authHeader.substring("Bearer ".length);
    try {
      await requireAdminUser(token, { action: ACTION_LABEL });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Acesso negado.";
      if (message.includes("não autenticado")) {
        return unauthorized(message, corsHeaders);
      }
      return forbidden(message, corsHeaders);
    }

    let payload: GraphPayload;
    try {
      payload = (await req.json()) as GraphPayload;
    } catch (error) {
      logger.warn("manageGraph: JSON inválido recebido", {
        error: error instanceof Error ? error.message : String(error),
      });
      return badRequest("JSON inválido no corpo da requisição.", corsHeaders);
    }

    if (!payload.company_id) {
      return badRequest("Campo company_id é obrigatório.", corsHeaders);
    }

    const slug = normalizeSlug(payload.slug ?? "", { resourceName: "gráfico", fieldLabel: "Slug" });
    const queryTemplate = ensureNonEmptyString(payload.query_template ?? "", { fieldLabel: "Query template" });
    const paramSchema = parseJsonObjectField(payload.param_schema, "param_schema");
    const defaultParams = parseJsonObjectField(payload.default_params, "default_params");
    const resultShape = parseJsonObjectField(payload.result_shape, "result_shape");
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
          text: "SELECT id FROM graficos_dashboard WHERE slug = $1",
          args: [slug],
        },
      );

      if (existing.rows.length > 0) {
        return conflict("Já existe um gráfico com este slug.", corsHeaders);
      }

      const insertResult = await client.queryObject<{ id: number }>(
        {
          text: `
            INSERT INTO graficos_dashboard (
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

      return jsonResponse(
        {
          message: "Gráfico cadastrado com sucesso.",
          graph_id: insertedId,
          slug,
          company_name: companyDb.company_name,
        },
        { status: 201, corsHeaders },
      );
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    logger.error("Erro na função manageGraph", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return serverError((error as Error).message ?? "Erro inesperado.", corsHeaders);
  }
});
