import { serve } from "std/http";
import { createClient } from "supabase";
import { Pool } from "postgres";

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
  const corsHeaders = {
    "Access-Control-Allow-Origin": Deno.env.get("FUNCTIONS_ALLOWED_ORIGIN") ?? "*",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-client-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }

  try {
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

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    );

    const { data: userAuth, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !userAuth.user) {
      return new Response(JSON.stringify({ error: "Invalid token or user not found" }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
    }

    const supabaseMaster = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const { data: userMasterRow, error: masterError } = await supabaseMaster
      .from("db_info")
      .select("db_host, db_name, db_user, db_password")
      .eq("id_user", userAuth.user.id)
      .single();

    if (masterError || !userMasterRow) {
      return new Response(JSON.stringify({ error: "Connection data not found" }), {
        status: 404,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      });
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
        return new Response(JSON.stringify({ error: "Parâmetro 'customer_id' inválido." }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
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
        return new Response(JSON.stringify({ error: "Cliente não encontrado." }), {
          status: 404,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
      }

      const [{ id, paused }] = updateResult.rows;

      const responseBody: ToggleResponseBody = {
        customer_id: id ?? customerId,
        paused: Boolean(paused),
      };

      return new Response(JSON.stringify(responseBody), {
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
  } catch (error) {
    console.error("toggleCustomerPaused: erro inesperado", error);
    return new Response(JSON.stringify({ error: (error as Error).message ?? "Erro inesperado" }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  }
});
