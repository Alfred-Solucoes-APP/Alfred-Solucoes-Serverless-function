// alfred-serverless/supabase/functions/fetchUserData/index.ts

import { serve } from "std/http";
import { createClient } from "supabase";
import { Pool } from "postgres";

type PrimitiveType = "string" | "number" | "date" | "array" | "boolean";

interface ParamSchemaEntry {
  type: PrimitiveType;
  required?: boolean;
  description?: string;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  items?: {
    type: PrimitiveType;
    enum?: (string | number | boolean)[];
    minimum?: number;
    maximum?: number;
  };
  default?: unknown;
}

type ParamSchema = Record<string, ParamSchemaEntry>;

interface GraphRecord {
  id: number;
  slug: string;
  title: string | null;
  description: string | null;
  query_template: string;
  param_schema: ParamSchema | null;
  default_params: Record<string, unknown> | null;
  result_shape: Record<string, unknown> | null;
  allowed_roles: string[] | string | null;
  is_active: boolean | null;
}

interface RequestGraph {
  slug: string;
  params?: Record<string, unknown>;
}

interface RequestBody {
  graphs?: RequestGraph[];
}

interface GraphResponse {
  id: number;
  slug: string;
  type: string;
  title: string | null;
  description: string | null;
  param_schema: ParamSchema | null;
  default_params: Record<string, unknown> | null;
  result_shape: Record<string, unknown> | null;
}

type DatasetMap = Record<number, Record<string, unknown>[]>;

const DATE_ONLY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

function safeJsonParse<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    return value as T;
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn("Falha ao fazer parse de JSON", { value, error });
      return null;
    }
  }
  return null;
}

function toDateOnlyISO(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function computeAutoDefaultValue(paramName: string, schema: ParamSchemaEntry): unknown {
  if (schema.default !== undefined) {
    return schema.default;
  }

  if (schema.type === "date") {
    const today = new Date();
    if (/fim|final|end/i.test(paramName)) {
      return toDateOnlyISO(today);
    }
    if (/inicio|início|start|begin/i.test(paramName)) {
      return toDateOnlyISO(addDays(today, -30));
    }
    return toDateOnlyISO(today);
  }

  if (schema.type === "number") {
    if (typeof schema.minimum === "number") {
      return schema.minimum;
    }
    if (typeof schema.maximum === "number" && schema.maximum < 1000) {
      return schema.maximum;
    }
    return 0;
  }

  if (schema.type === "array" && schema.items?.enum && schema.items.enum.length > 0) {
    return schema.items.enum;
  }

  return undefined;
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return false;
}

function normalizeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  throw new Error(`Valor numérico inválido: ${value}`);
}

function normalizeDate(value: unknown): string {
  if (typeof value === "string" && DATE_ONLY_FORMAT.test(value)) {
    return value;
  }
  if (value instanceof Date) {
    return toDateOnlyISO(value);
  }
  if (typeof value === "number") {
    const fromEpoch = new Date(value);
    if (!Number.isNaN(fromEpoch.getTime())) {
      return toDateOnlyISO(fromEpoch);
    }
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return toDateOnlyISO(parsed);
    }
  }
  throw new Error(`Valor de data inválido: ${value}`);
}

function normalizeString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function normalizeArrayValue(value: unknown, schema: ParamSchemaEntry["items"]): unknown[] {
  const ensureArray = (input: unknown): unknown[] => {
    if (Array.isArray(input)) {
      return input;
    }
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (trimmed === "") {
        return [];
      }
      return trimmed
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
    }
    if (input === undefined || input === null) {
      return [];
    }
    return [input];
  };

  const baseArray = ensureArray(value);
  if (!schema) {
    return baseArray;
  }

  return baseArray.map((item) => {
    switch (schema.type) {
      case "number": {
        const numericValue = normalizeNumber(item);
        if (typeof schema.minimum === "number" && numericValue < schema.minimum) {
          throw new Error(`Valor do array abaixo do mínimo permitido (${schema.minimum}).`);
        }
        if (typeof schema.maximum === "number" && numericValue > schema.maximum) {
          throw new Error(`Valor do array acima do máximo permitido (${schema.maximum}).`);
        }
        return numericValue;
      }
      case "boolean":
        return normalizeBoolean(item);
      case "date":
        return normalizeDate(item);
      case "string":
      default: {
        const strValue = normalizeString(item);
        if (schema.enum && schema.enum.length > 0 && !schema.enum.map(String).includes(strValue)) {
          throw new Error(`Valor '${strValue}' não é permitido para o campo.`);
        }
        return strValue;
      }
    }
  });
}

function normalizeValue(paramName: string, schema: ParamSchemaEntry, value: unknown): unknown {
  if (value === undefined || value === null) {
    if (schema.required) {
      throw new Error(`Parâmetro obrigatório ausente: ${paramName}`);
    }
    return undefined;
  }

  switch (schema.type) {
    case "number": {
      const numericValue = normalizeNumber(value);
      if (typeof schema.minimum === "number" && numericValue < schema.minimum) {
        throw new Error(`Valor de '${paramName}' abaixo do mínimo permitido (${schema.minimum}).`);
      }
      if (typeof schema.maximum === "number" && numericValue > schema.maximum) {
        throw new Error(`Valor de '${paramName}' acima do máximo permitido (${schema.maximum}).`);
      }
      if (schema.enum && schema.enum.length > 0 && !schema.enum.map(Number).includes(numericValue)) {
        throw new Error(`Valor '${numericValue}' não é permitido para '${paramName}'.`);
      }
      return numericValue;
    }
    case "date":
      return normalizeDate(value);
    case "boolean":
      return normalizeBoolean(value);
    case "array":
      return normalizeArrayValue(value, schema.items);
    case "string":
    default: {
      const stringValue = normalizeString(value);
      if (schema.enum && schema.enum.length > 0 && !schema.enum.map(String).includes(stringValue)) {
        throw new Error(`Valor '${stringValue}' não é permitido para '${paramName}'.`);
      }
      return stringValue;
    }
  }
}

function resolveParams(
  schema: ParamSchema,
  defaults: Record<string, unknown> | null,
  provided: Record<string, unknown> | undefined
): Record<string, unknown> {
  const finalParams: Record<string, unknown> = {};
  const schemaEntries = Object.entries(schema ?? {});

  for (const [paramName, entry] of schemaEntries) {
    const suppliedValue = provided && Object.hasOwn(provided, paramName) ? provided[paramName] : undefined;
    const defaultValue = defaults && Object.hasOwn(defaults, paramName) ? defaults[paramName] : undefined;

    let valueToUse = suppliedValue ?? defaultValue;
    if (valueToUse === undefined) {
      valueToUse = computeAutoDefaultValue(paramName, entry);
    }

    const normalized = normalizeValue(paramName, entry, valueToUse);
    if (normalized !== undefined) {
      finalParams[paramName] = normalized;
    }
  }

  if (provided) {
    for (const [key, value] of Object.entries(provided)) {
      if (!schemaEntries.some(([schemaKey]) => schemaKey === key)) {
        console.warn(`Parâmetro '${key}' fornecido não está definido no schema. Será aceito sem validação.`);
        finalParams[key] = value;
      }
    }
  }

  return finalParams;
}

function sanitizeValueForJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValueForJson(item));
  }

  if (typeof value === "object") {
    return sanitizeRowForJson(value as Record<string, unknown>);
  }

  return value;
}

function sanitizeRowForJson(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key] = sanitizeValueForJson(value);
  }
  return normalized;
}

function buildParameterizedQuery(
  template: string,
  params: Record<string, unknown>,
  schema?: ParamSchema
): { text: string; args: unknown[] } {
  const placeholderRegex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
  const args: unknown[] = [];
  const usedParams = new Set<string>();

  type PlaceholderMeta = {
    index: number;
    paramName: string;
    isArray: boolean;
  };

  const placeholderMeta: PlaceholderMeta[] = [];

  let text = template.replace(placeholderRegex, (_match, paramNameRaw: string) => {
    const paramName = paramNameRaw.trim();
    if (!Object.prototype.hasOwnProperty.call(params, paramName)) {
      throw new Error(`Parâmetro '${paramName}' não foi informado para a query.`);
    }
    usedParams.add(paramName);
    args.push(params[paramName]);
    const index = args.length;
    const schemaEntry = schema?.[paramName];
    const isArrayParam = schemaEntry?.type === "array" || Array.isArray(params[paramName]);
    placeholderMeta.push({ index, paramName, isArray: Boolean(isArrayParam) });
    return `$${index}`;
  });

  for (const meta of placeholderMeta) {
    if (!meta.isArray) {
      continue;
    }

    const maybeCastPattern = `(\\s*::[a-zA-Z0-9_\\[\\]]+)?`;

    const notInPattern = new RegExp(`\\bNOT\\s+IN\\s*\\(\\s*\\$${meta.index}${maybeCastPattern}\\s*\\)`, "gi");
    text = text.replace(notInPattern, (_match, cast = "") => `<> ALL($${meta.index}${cast ?? ""})`);

    const inPattern = new RegExp(`\\bIN\\s*\\(\\s*\\$${meta.index}${maybeCastPattern}\\s*\\)`, "gi");
    text = text.replace(inPattern, (_match, cast = "") => `= ANY($${meta.index}${cast ?? ""})`);
  }

  for (const paramName of Object.keys(params)) {
    if (!usedParams.has(paramName)) {
      console.warn(`Parâmetro '${paramName}' não foi utilizado na query_template.`);
    }
  }

  return { text, args };
}

async function parseRequestBody(req: Request): Promise<RequestBody> {
  try {
    const raw = await req.text();
    if (!raw || raw.trim() === "") {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return parsed as RequestBody;
  } catch (error) {
    console.warn("Falha ao interpretar o corpo da requisição", error);
    return {};
  }
}

function normalizeAllowedRoles(value: GraphRecord["allowed_roles"]): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((role) => String(role).trim()).filter(Boolean);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((item) => item.replace(/"/g, "").trim())
        .filter(Boolean);
    }
    return trimmed
      .split(",")
      .map((role) => role.replace(/"/g, "").trim())
      .filter(Boolean);
  }

  return [];
}

function extractUserRoles(user: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }): string[] {
  const roles = new Set<string>(["user", "authenticated"]);

  const { app_metadata, user_metadata } = user;

  const possibleSources = [
    app_metadata?.role,
    user_metadata?.role,
    app_metadata?.roles,
    user_metadata?.roles,
  ];

  for (const source of possibleSources) {
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

  return Array.from(roles);
}

function normalizeGraphRecord(row: Record<string, unknown>): GraphRecord {
  const paramSchema = safeJsonParse<ParamSchema>(row.param_schema) ?? (typeof row.param_schema === "object" && row.param_schema !== null
    ? (row.param_schema as ParamSchema)
    : null);

  const defaultParams = safeJsonParse<Record<string, unknown>>(row.default_params) ?? (typeof row.default_params === "object" && row.default_params !== null
    ? (row.default_params as Record<string, unknown>)
    : null);

  const resultShape = safeJsonParse<Record<string, unknown>>(row.result_shape) ?? (typeof row.result_shape === "object" && row.result_shape !== null
    ? (row.result_shape as Record<string, unknown>)
    : null);

  let allowedRoles: GraphRecord["allowed_roles"] = null;
  if (Array.isArray(row.allowed_roles)) {
    allowedRoles = row.allowed_roles as string[];
  } else if (typeof row.allowed_roles === "string") {
    allowedRoles = row.allowed_roles;
  }

  const isActiveValue = row.is_active;
  let isActive: boolean | null = null;
  if (typeof isActiveValue === "boolean") {
    isActive = isActiveValue;
  } else if (typeof isActiveValue === "number") {
    isActive = isActiveValue !== 0;
  }

  return {
    id: typeof row.id === "number" ? row.id : Number(row.id),
    slug: String(row.slug ?? ""),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    query_template: String(row.query_template ?? ""),
    param_schema: paramSchema,
    default_params: defaultParams,
    result_shape: resultShape,
    allowed_roles: allowedRoles,
    is_active: isActive,
  };
}

serve(async (req: Request) => {
  // CORS headers comuns
  const corsHeaders = {
    "Access-Control-Allow-Origin": Deno.env.get("FUNCTIONS_ALLOWED_ORIGIN") ?? "*", // troque pelo domínio do frontend em produção se quiser mais seguro
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info, x-client-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Preflight OPTIONS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain",
        },
      });
    }

    // Autorização JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing or invalid Authorization header" }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }
    const token = authHeader.substring("Bearer ".length);

    // Cliente para validar o token
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

    const { data: userAuth, error: errAuth } = await supabaseClient.auth.getUser(token);
    if (errAuth || !userAuth.user) {
      return new Response(JSON.stringify({ error: "Invalid token or user not found" }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }
    const user_id = userAuth.user.id;

    // Consulta master_db
    const supabaseMaster = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: userMasterRow, error: errMaster } = await supabaseMaster
      .from("db_info")
      .select("db_host, db_name, db_user, db_password, company_name")
      .eq("id_user", user_id)
      .single();

    if (errMaster || !userMasterRow) {
      return new Response(JSON.stringify({ error: "User master record not found" }), {
        status: 404,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    const { db_host, db_name, db_user, db_password, company_name } = userMasterRow;
    const dbPort = Deno.env.get("CLIENT_DB_DEFAULT_PORT") ?? "5432";

    const clientConnectionUrl = `postgres://${encodeURIComponent(db_user)}:${encodeURIComponent(db_password)}@${db_host}:${dbPort}/${db_name}`;

    const pool = new Pool(clientConnectionUrl, 5, true);
    const client = await pool.connect();

    try {
      const requestBody = await parseRequestBody(req);
      const requestedGraphs = Array.isArray(requestBody.graphs) ? requestBody.graphs : null;
      const requestedSlugs = requestedGraphs?.map((graph) => graph.slug).filter(Boolean) ?? [];
      const providedParamsMap = new Map<string, Record<string, unknown>>();
      for (const graph of requestedGraphs ?? []) {
        if (graph.slug) {
          providedParamsMap.set(graph.slug, graph.params ?? {});
        }
      }

      const userRoles = extractUserRoles(userAuth.user);

      const queryArgs: unknown[] = [];
      let baseQuery = `
        SELECT
          id,
          slug,
          title,
          description,
          query_template,
          param_schema,
          default_params,
          result_shape,
          allowed_roles,
          is_active
        FROM graficos
        WHERE is_active IS DISTINCT FROM FALSE
      `;

      if (requestedSlugs.length > 0) {
        queryArgs.push(requestedSlugs);
        baseQuery += ` AND slug = ANY($${queryArgs.length}::text[])`;
      }

      baseQuery += " ORDER BY id";

      const resultGraphics = await client.queryObject<Record<string, unknown>>({ text: baseQuery, args: queryArgs });

  const datasets: DatasetMap = {};
  const debug: Record<number, unknown> = {};
  const errors: Record<string, unknown> = {};
  const graphics: GraphResponse[] = [];

      const returnedSlugs = new Set<string>();

      for (const row of resultGraphics.rows) {
        const graphRecord = normalizeGraphRecord(row);
        returnedSlugs.add(graphRecord.slug);

        if (!graphRecord.query_template || graphRecord.query_template.trim() === "") {
          errors[graphRecord.slug] = "Query template vazio.";
          continue;
        }

        const allowedRoles = normalizeAllowedRoles(graphRecord.allowed_roles);
        if (allowedRoles.length > 0 && !allowedRoles.some((role) => userRoles.includes(role))) {
          errors[graphRecord.slug] = "Usuário não possui permissão para este gráfico.";
          continue;
        }

        const schema = graphRecord.param_schema ?? {};
        const defaults = graphRecord.default_params ?? {};
        const provided = providedParamsMap.get(graphRecord.slug);

        let resolvedParams: Record<string, unknown> = {};
        try {
          resolvedParams = resolveParams(schema, defaults, provided);
        } catch (paramError) {
          errors[graphRecord.slug] = (paramError as Error).message;
          continue;
        }

        let sql: { text: string; args: unknown[] };
        try {
          sql = buildParameterizedQuery(graphRecord.query_template, resolvedParams, graphRecord.param_schema ?? {});
        } catch (templateError) {
          errors[graphRecord.slug] = (templateError as Error).message;
          continue;
        }

        try {
          const queryResult = await client.queryObject<Record<string, unknown>>(sql);
          const normalizedRows = queryResult.rows.map((row) => sanitizeRowForJson(row));
          datasets[graphRecord.id] = normalizedRows;
          debug[graphRecord.id] = {
            slug: graphRecord.slug,
            params: resolvedParams,
            query: sql.text,
            args: sql.args,
            rowCount: queryResult.rows.length,
            sample: normalizedRows.slice(0, 5),
          };
        } catch (queryError) {
          errors[graphRecord.slug] = (queryError as Error).message;
          continue;
        }

        graphics.push({
          id: graphRecord.id,
          slug: graphRecord.slug,
          type: graphRecord.slug,
          title: graphRecord.title,
          description: graphRecord.description,
          param_schema: graphRecord.param_schema,
          default_params: graphRecord.default_params,
          result_shape: graphRecord.result_shape,
        });
      }

      if (requestedSlugs.length > 0) {
        for (const slug of requestedSlugs) {
          if (!returnedSlugs.has(slug)) {
            errors[slug] = "Gráfico não encontrado ou inativo.";
          }
        }
      }

      const responsePayload = {
        company_name,
        graphics,
        datasets,
        debug,
        errors,
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    } finally {
      client.release();
      await pool.end();
    }

  } catch (e) {
    console.error("Erro na função fetchUserData:", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
});
