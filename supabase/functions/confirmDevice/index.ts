import { serve } from "std/http";
import {
  buildCorsHeaders,
  handlePreflight,
  methodNotAllowed,
  jsonResponse,
  logger,
  getDeviceRecordByToken,
  updateDeviceRecord,
  getAuthUserById,
  recordLoginEvent,
  buildLoginEmail,
  sendEmail,
} from "../_shared/mod.ts";

const DEFAULT_DEVICE_NAME = "Dispositivo desconhecido";

function sanitizeToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function successHtml(message: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Dispositivo confirmado</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5ff; color: #1f1f3d; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { background: #ffffff; padding: 32px; border-radius: 12px; max-width: 480px; box-shadow: 0 16px 40px rgba(79, 70, 229, 0.12); text-align: center; }
      h1 { font-size: 24px; margin-bottom: 12px; }
      p { font-size: 16px; line-height: 1.5; }
      a { color: #4f46e5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Dispositivo confirmado</h1>
      <p>${message}</p>
      <p>Você pode fechar esta aba e retornar ao aplicativo.</p>
    </div>
  </body>
</html>`;
}

function errorHtml(message: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>Token inválido</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fef2f2; color: #7f1d1d; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { background: #ffffff; padding: 32px; border-radius: 12px; max-width: 480px; box-shadow: 0 16px 40px rgba(127, 29, 29, 0.12); text-align: center; }
      h1 { font-size: 24px; margin-bottom: 12px; }
      p { font-size: 16px; line-height: 1.5; }
      a { color: #c53030; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Não foi possível confirmar</h1>
      <p>${message}</p>
      <p>Solicite um novo login no aplicativo para receber outro e-mail de verificação.</p>
    </div>
  </body>
</html>`;
}

serve(async (request) => {
  const corsHeaders = buildCorsHeaders({ methods: ["GET", "POST", "OPTIONS"] });

  const preflight = handlePreflight(request, corsHeaders);
  if (preflight) {
    return preflight;
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return methodNotAllowed(corsHeaders);
  }

  try {
    let token: string | null = null;

    if (method === "GET") {
      const url = new URL(request.url);
      token = sanitizeToken(url.searchParams.get("token"));
    } else {
      const body = await request.json().catch(() => ({}));
      token = sanitizeToken((body as Record<string, unknown>).token);
    }

    if (!token) {
      if (method === "GET") {
        return new Response(errorHtml("Token ausente ou inválido."), {
          status: 400,
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
        });
      }
      return jsonResponse({ error: "Token ausente." }, { status: 400, corsHeaders });
    }

    const deviceRecord = await getDeviceRecordByToken(token);
    if (!deviceRecord) {
      if (method === "GET") {
        return new Response(errorHtml("Token não encontrado ou já utilizado."), {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
        });
      }
      return jsonResponse({ error: "Token inválido." }, { status: 404, corsHeaders });
    }

    const now = new Date();
    const updatedRecord = await updateDeviceRecord(deviceRecord.id, {
      status: "approved",
      confirmed_at: now.toISOString(),
      approval_token: null,
      last_seen_at: now.toISOString(),
    });

    const authUser = await getAuthUserById(deviceRecord.user_id);
    const emailAddress = authUser?.email ?? "";

    await recordLoginEvent({
      userId: deviceRecord.user_id,
      deviceId: updatedRecord.device_id,
      deviceName: updatedRecord.device_name ?? DEFAULT_DEVICE_NAME,
      ipAddress: updatedRecord.ip_address ?? null,
      userAgent: updatedRecord.user_agent ?? null,
      locale: updatedRecord.locale ?? null,
      timezone: updatedRecord.timezone ?? null,
    });

    if (emailAddress) {
      const loginEmail = buildLoginEmail({
        userName: emailAddress,
        deviceName: updatedRecord.device_name ?? DEFAULT_DEVICE_NAME,
        ipAddress: updatedRecord.ip_address ?? null,
        locale: updatedRecord.locale ?? null,
        timezone: updatedRecord.timezone ?? null,
        createdAt: now,
      });
      await sendEmail({ to: emailAddress, subject: loginEmail.subject, html: loginEmail.html, text: loginEmail.text });
    }

    if (method === "GET") {
      return new Response(successHtml("Confirmamos o dispositivo com sucesso."), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }

    return jsonResponse({ status: "approved" }, { status: 200, corsHeaders });
  } catch (error) {
    logger.error("confirmDevice: unexpected error", { message: error instanceof Error ? error.message : String(error) });
    if (request.method.toUpperCase() === "GET") {
      return new Response(errorHtml("Erro inesperado ao confirmar dispositivo."), {
        status: 500,
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
      });
    }
    return jsonResponse({ error: "Erro inesperado." }, { status: 500, corsHeaders });
  }
});
