import { serve } from "std/http";
import { createClient } from "supabase";
import { Pool } from "postgres";
import {
  applyRateLimit,
  badRequest,
  buildCorsHeaders,
  handlePreflight,
  jsonResponse,
  methodNotAllowed,
  notFound,
  requireAuthenticatedUser,
  serverError,
  unauthorized,
  getBearerToken,
  getClientIp,
  requireApprovedDevice,
  getClientDeviceId,
  forbidden,
} from "../_shared/mod.ts";

type ToggleRequestBody = {
  customer_id?: number | string;
};

type ToggleResponseBody = {
  customer_id: number | string;
  paused: boolean;
};

function parseRequestBody(bodyText: string | null): ToggleRequestBody {
  if (!bodyText || bodyText.trim() === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ToggleRequestBody;
    }
    return {};
  } catch (error) {
    console.warn("toggleCustomerPaused: falha ao interpretar corpo", error);
    return {};
  }
}

function parseCustomerIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    return trimmed;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return null;
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
    const rateLimitResponse = applyRateLimit(req, corsHeaders, {
      identifier: "toggleCustomerPaused",
      max: 10,
      windowMs: 60_000,
      message: "Muitas tentativas de alternar clientes. Aguarde um instante e tente novamente.",
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

  let authUser: Awaited<ReturnType<typeof requireAuthenticatedUser>>;
    try {
      authUser = await requireAuthenticatedUser(token);
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : "Usuário não autenticado.";
      return unauthorized(message, corsHeaders);
    }

    const clientDeviceId = getClientDeviceId(req);
    try {
      await requireApprovedDevice(authUser.id, clientDeviceId);
    } catch (deviceError) {
      const message = deviceError instanceof Error ? deviceError.message : "Dispositivo não autorizado.";
      return forbidden(message, corsHeaders);
    }

    const supabaseMaster = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: userMasterRow, error: masterError } = await supabaseMaster
      .from("db_info")
      .select("db_host, db_name, db_user, db_password")
      .eq("id_user", authUser.id)
      .single();

    if (masterError || !userMasterRow) {
      return notFound("Connection data not found", corsHeaders);
    }

    const { db_host, db_name, db_user, db_password } = userMasterRow;
    const dbPort = Deno.env.get("CLIENT_DB_DEFAULT_PORT") ?? "5432";

    const clientConnectionUrl = `postgres://${encodeURIComponent(db_user)}:${encodeURIComponent(db_password)}@${db_host}:${dbPort}/${db_name}`;

    const pool = new Pool(clientConnectionUrl, 5, true);
    const client = await pool.connect();

    try {
      const rawBody = await req.text();
      const body = parseRequestBody(rawBody);

      const customerId = parseCustomerIdentifier(body.customer_id);
      if (customerId === null) {
        return badRequest("Parâmetro 'customer_id' inválido.", corsHeaders);
      }

      const updateResult = await client.queryObject<{ id: number | string | null; paused: boolean | null }>({
        text: `
          UPDATE clientes
          SET paused = NOT COALESCE(paused, false)
          WHERE id::text = $1::text
          RETURNING id, paused
        `,
        args: [customerId],
      });

      if (updateResult.rows.length === 0) {
        return notFound("Cliente não encontrado.", corsHeaders);
      }

      const [{ id, paused }] = updateResult.rows;

      const responseBody: ToggleResponseBody = {
        customer_id: id ?? customerId,
        paused: Boolean(paused),
      };

      return jsonResponse(responseBody, { status: 200, corsHeaders });
    } finally {
      client.release();
      await pool.end();
    }
  } catch (error) {
    console.error("toggleCustomerPaused: erro inesperado", error);
    const message = error instanceof Error ? error.message : "Erro inesperado";
    return serverError(message, corsHeaders);
  }
});
