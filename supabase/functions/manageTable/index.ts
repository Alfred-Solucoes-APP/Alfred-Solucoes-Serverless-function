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
  parsePrimaryKey,
  getCompanyConnection,
  logger,
} from "../_shared/mod.ts";

type TableColumnConfig = {
  key: string;
  label: string;
  type?: "string" | "number" | "date" | "boolean";
  align?: "left" | "center" | "right";
  width?: string;
  is_toggle?: boolean;
  hidden?: boolean;
};

type TablePayload = {
  company_id: string;
  slug: string;
  title?: string | null;
  description?: string | null;
  query_template: string;
  column_config: unknown;
  param_schema?: unknown;
  default_params?: unknown;
  result_shape?: unknown;
  allowed_roles?: unknown;
  primary_key?: string | null;
  is_active?: boolean;
};

const ACTION_LABEL = "gerenciar tabelas";

function parseColumnConfig(value: unknown): TableColumnConfig[] {
  const normalize = (entries: TableColumnConfig[]): TableColumnConfig[] => {
    const result: TableColumnConfig[] = [];
    for (const entry of entries) {
      const key = entry.key?.trim();
      if (!key) {
        continue;
      }
      const label = entry.label?.trim() || key;
      const normalized: TableColumnConfig = { key, label };

      if (entry.type && ["string", "number", "date", "boolean"].includes(entry.type)) {
        normalized.type = entry.type;
      }

      if (entry.align && ["left", "center", "right"].includes(entry.align)) {
        normalized.align = entry.align;
      }

      if (entry.width && entry.width.trim().length > 0) {
        normalized.width = entry.width.trim();
      }

      if (typeof entry.is_toggle === "boolean") {
        normalized.is_toggle = entry.is_toggle;
      }

      if (typeof entry.hidden === "boolean") {
        normalized.hidden = entry.hidden;
      }

      result.push(normalized);
    }
    return result;
  };

  if (Array.isArray(value)) {
    const converted = value
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return null;
        }
        return entry as Record<string, unknown>;
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        key: typeof entry.key === "string" ? entry.key : "",
        label: typeof entry.label === "string" ? entry.label : "",
        type: typeof entry.type === "string" ? (entry.type.toLowerCase() as TableColumnConfig["type"]) : undefined,
        align: typeof entry.align === "string" ? (entry.align.toLowerCase() as TableColumnConfig["align"]) : undefined,
        width: typeof entry.width === "string" ? entry.width : undefined,
        is_toggle: typeof entry.is_toggle === "boolean" ? entry.is_toggle : undefined,
        hidden: typeof entry.hidden === "boolean" ? entry.hidden : undefined,
      }));

    return normalize(converted);
  }

  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseColumnConfig(parsed);
    } catch (error) {
      throw new Error(`Campo 'column_config' não contém um JSON válido: ${(error as Error).message}`);
    }
  }

  throw new Error("Campo 'column_config' é obrigatório e deve ser um array de colunas.");
}

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

    let payload: TablePayload;
    try {
      payload = (await req.json()) as TablePayload;
    } catch (error) {
      logger.warn("manageTable: JSON inválido recebido", {
        error: error instanceof Error ? error.message : String(error),
      });
      return badRequest("JSON inválido no corpo da requisição.", corsHeaders);
    }

    if (!payload.company_id) {
      return badRequest("Campo company_id é obrigatório.", corsHeaders);
    }

    const slug = normalizeSlug(payload.slug ?? "", { resourceName: "tabela", fieldLabel: "Slug" });
    const queryTemplate = ensureNonEmptyString(payload.query_template ?? "", { fieldLabel: "Query template" });
    const columnConfig = parseColumnConfig(payload.column_config);
    if (columnConfig.length === 0) {
      throw new Error("Defina pelo menos uma coluna para a tabela.");
    }
    const paramSchema = payload.param_schema ? parseJsonObjectField(payload.param_schema, "param_schema") : null;
    const defaultParams = payload.default_params ? parseJsonObjectField(payload.default_params, "default_params") : null;
    const resultShape = payload.result_shape ? parseJsonObjectField(payload.result_shape, "result_shape") : null;
    const allowedRoles = parseAllowedRoles(payload.allowed_roles);
    const primaryKey = parsePrimaryKey(payload.primary_key);
    const isActive = payload.is_active ?? true;

    const companyDb = await getCompanyConnection(payload.company_id);
    const dbPort = Deno.env.get("CLIENT_DB_DEFAULT_PORT") ?? "5432";

    const connectionUrl = `postgres://${encodeURIComponent(companyDb.db_user)}:${encodeURIComponent(companyDb.db_password)}@${companyDb.db_host}:${dbPort}/${companyDb.db_name}`;

    const pool = new Pool(connectionUrl, 2, true);
    const client = await pool.connect();

    try {
      const existing = await client.queryObject<{ id: number }>({
        text: "SELECT id FROM dashboard_tables WHERE slug = $1",
        args: [slug],
      });

      if (existing.rows.length > 0) {
        return conflict("Já existe uma tabela com este slug.", corsHeaders);
      }

      const insertResult = await client.queryObject<{ id: number }>({
        text: `
          INSERT INTO dashboard_tables (
            slug,
            title,
            description,
            query_template,
            column_config,
            param_schema,
            default_params,
            result_shape,
            allowed_roles,
            primary_key,
            is_active
          ) VALUES (
            $1,
            $2,
            $3,
            $4,
            $5::jsonb,
            $6::jsonb,
            $7::jsonb,
            $8::jsonb,
            $9::text[],
            $10,
            $11
          )
          RETURNING id
        `,
        args: [
          slug,
          payload.title ?? null,
          payload.description ?? null,
          queryTemplate,
          JSON.stringify(columnConfig),
          paramSchema ? JSON.stringify(paramSchema) : null,
          defaultParams ? JSON.stringify(defaultParams) : null,
          resultShape ? JSON.stringify(resultShape) : null,
          allowedRoles,
          primaryKey,
          isActive,
        ],
      });

      const insertedId = insertResult.rows[0]?.id ?? null;

      return jsonResponse(
        {
          message: "Tabela cadastrada com sucesso.",
          table_id: insertedId,
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
    logger.error("Erro na função manageTable", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return serverError((error as Error).message ?? "Erro inesperado.", corsHeaders);
  }
});
