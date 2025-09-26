// alfred-serverless/supabase/functions/fetchUserData/index.ts

import { serve } from "std/http";
import { createClient } from "supabase";
import { Pool } from "postgres";

interface GraphicsConfig {
  id: number;
  type: string;
  config: Record<string, unknown>;
}

serve(async (req: Request) => {
  // CORS headers comuns
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",  // trocar "*" pelo domínio do seu frontend em produção, se quiser mais seguro
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
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
      .from("users_master")
      .select("db_host, db_name, db_user, db_password")
      .eq("user_id", user_id)
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

    const { db_host, db_name, db_user, db_password } = userMasterRow;
    const dbPort = Deno.env.get("CLIENT_DB_DEFAULT_PORT") ?? "5432";

    const clientConnectionUrl = `postgres://${encodeURIComponent(db_user)}:${encodeURIComponent(db_password)}@${db_host}:${dbPort}/${db_name}`;

    const pool = new Pool(clientConnectionUrl, 5, true);
    const client = await pool.connect();

    try {
      const resultGraphics = await client.queryObject<GraphicsConfig>(
        `SELECT id, type, config FROM graphics`
      );
      const graphics = resultGraphics.rows;

      const datasets: Record<number, any[]> = {};

      for (const gfx of graphics) {
        const { id, type, config } = gfx;

        let dataForGraph: any[] = [];

        if (type === "reservas_por_mes") {
          const start = (config["startDate"] as string) ?? null;
          const end = (config["endDate"] as string) ?? null;

          if (start && end) {
            const q = `
              SELECT
                EXTRACT(MONTH FROM data_checkin) AS mes,
                COUNT(*) AS total
              FROM reservas
              WHERE data_checkin BETWEEN $1::date AND $2::date
              GROUP BY mes
              ORDER BY mes
            `;
            const resp = await client.queryObject({ text: q, args: [start, end] });
            dataForGraph = resp.rows;
          } else {
            dataForGraph = [];
          }

        } else if (type === "quartos_mais_reservados") {
          const start = (config["startDate"] as string) ?? null;
          const end = (config["endDate"] as string) ?? null;

          if (start && end) {
            const q = `
              SELECT
                quarto_id,
                COUNT(*) AS total_reservas
              FROM reservas
              WHERE data_checkin BETWEEN $1::date AND $2::date
              GROUP BY quarto_id
              ORDER BY total_reservas DESC
            `;
            const resp = await client.queryObject({ text: q, args: [start, end] });
            dataForGraph = resp.rows;
          } else {
            dataForGraph = [];
          }

        } else if (type === "clientes_por_mes") {
          const start = (config["startDate"] as string) ?? null;
          const end = (config["endDate"] as string) ?? null;

          if (start && end) {
            const q = `
              SELECT
                EXTRACT(MONTH FROM created_at) AS mes,
                COUNT(*) AS total_clientes
              FROM clientes
              WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz
              GROUP BY mes
              ORDER BY mes
            `;
            const resp = await client.queryObject({ text: q, args: [start, end] });
            dataForGraph = resp.rows;
          } else {
            dataForGraph = [];
          }

        } else {
          dataForGraph = [];
        }

        datasets[id] = dataForGraph;
      }

      const responsePayload = {
        graphics,
        datasets,
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
    }

  } catch (e) {
    console.error("Erro na função fetchUserData:", e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...{
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "authorization, content-type, apikey",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
          },
        },
      }
    );
  }
});
