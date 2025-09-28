// alfred-serverless/supabase/functions/fetchUserData/index.ts

import { serve } from "std/http";
import { createClient } from "supabase";
import { Pool } from "postgres";

interface GraphicsConfig {
  id: number;
  type: string;
  config: Record<string, unknown>;
}

type DateRange = {
  start: string | null;
  end: string | null;
};

function extractDateRange(config: Record<string, unknown> = {}): DateRange {
  const normalize = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value : null;

  let start = normalize(config["startDate"]);
  let end = normalize(config["endDate"]);

  if (!start || !end) {
    start = start ?? normalize(config["start"]);
    end = end ?? normalize(config["end"]);
  }

  const range = config["dateRange"];
  if ((!start || !end) && range && typeof range === "object") {
    const rangeRecord = range as Record<string, unknown>;
    start = start ?? normalize(rangeRecord["startDate"]);
    end = end ?? normalize(rangeRecord["endDate"]);
    start = start ?? normalize(rangeRecord["start"]);
    end = end ?? normalize(rangeRecord["end"]);
  }

  return { start: start ?? null, end: end ?? null };
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
      const resultGraphics = await client.queryObject<GraphicsConfig>(
        `SELECT id, type, config FROM graphics`
      );
      const graphics = resultGraphics.rows.map((gfx) => {
        const rawType = gfx.type;
        const normalizedType = typeof rawType === "string"
          ? rawType.trim().replace(/^["']+|["']+$/g, "")
          : String(rawType ?? "").trim();
        return {
          ...gfx,
          type: normalizedType,
        };
      });

      const datasets: Record<number, any[]> = {};
      const debug: Record<number, unknown> = {};
      const globalDebug: Record<string, unknown> = {};

      try {
        const reservasStats = await client.queryObject<{
          total: number;
          min_data_checkin: string | null;
          max_data_checkin: string | null;
        }>(
          `
            SELECT
              COUNT(*)::int AS total,
              MIN(data_checkin)::text AS min_data_checkin,
              MAX(data_checkin)::text AS max_data_checkin
            FROM reservas
          `
        );
        globalDebug.reservasStats = reservasStats.rows[0] ?? null;
      } catch (statsError) {
        globalDebug.reservasStatsError = (statsError as Error).message;
      }

      for (const gfx of graphics) {
        const { id, type, config } = gfx;

        let dataForGraph: any[] = [];
        const dateRange = extractDateRange(config);
        const { start, end } = dateRange;

        if (type === "reservas_por_mes") {
          const args: string[] = [];

          let whereClause = "";
          if (start && end) {
            whereClause = "WHERE data_checkin BETWEEN $1::date AND $2::date";
            args.push(start, end);
          } else if (start) {
            whereClause = "WHERE data_checkin >= $1::date";
            args.push(start);
          } else if (end) {
            whereClause = "WHERE data_checkin <= $1::date";
            args.push(end);
          }

          const q = `
            SELECT
              EXTRACT(MONTH FROM data_checkin) AS mes,
              COUNT(*)::int AS total
            FROM reservas
            ${whereClause}
            GROUP BY mes
            ORDER BY mes
          `;
          const resp = await client.queryObject({ text: q, args });
          dataForGraph = resp.rows;

        } else if (type === "quartos_mais_reservados") {
          const args: string[] = [];

          let whereClause = "";
          if (start && end) {
            whereClause = "WHERE r.data_checkin BETWEEN $1::date AND $2::date";
            args.push(start, end);
          } else if (start) {
            whereClause = "WHERE r.data_checkin >= $1::date";
            args.push(start);
          } else if (end) {
            whereClause = "WHERE r.data_checkin <= $1::date";
            args.push(end);
          }

          const q = `
            SELECT
              COALESCE(q.numero::text, r.quarto_id::text) AS numero_quarto,
              r.quarto_id,
              COUNT(*)::int AS total_reservas
            FROM reservas r
            LEFT JOIN quartos q ON q.id = r.quarto_id
            ${whereClause}
            GROUP BY numero_quarto, r.quarto_id
            ORDER BY total_reservas DESC
          `;
          const resp = await client.queryObject({ text: q, args });
          dataForGraph = resp.rows;

        } else if (type === "clientes_por_mes") {
          const args: string[] = [];

          let whereClause = "";
          if (start && end) {
            whereClause = "WHERE created_at BETWEEN $1::timestamptz AND $2::timestamptz";
            args.push(start, end);
          } else if (start) {
            whereClause = "WHERE created_at >= $1::timestamptz";
            args.push(start);
          } else if (end) {
            whereClause = "WHERE created_at <= $1::timestamptz";
            args.push(end);
          }

          const q = `
            SELECT
              EXTRACT(MONTH FROM created_at) AS mes,
              COUNT(*)::int AS total_clientes
            FROM clientes
            ${whereClause}
            GROUP BY mes
            ORDER BY mes
          `;
          const resp = await client.queryObject({ text: q, args });
          dataForGraph = resp.rows;

        } else {
          dataForGraph = [];
        }

        console.log(
          "fetchUserData dataset",
          JSON.stringify({
            graph_id: id,
            type,
            config,
            startDate: dateRange.start,
            endDate: dateRange.end,
            rowCount: dataForGraph.length,
            sample: dataForGraph.slice(0, 5),
          })
        );

        datasets[id] = dataForGraph;
        debug[id] = {
          type,
          dateRange,
          rowCount: dataForGraph.length,
          sample: dataForGraph.slice(0, 5),
        };
      }

      const responsePayload = {
        company_name,
        graphics,
        datasets,
        debug,
        globalDebug,
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
