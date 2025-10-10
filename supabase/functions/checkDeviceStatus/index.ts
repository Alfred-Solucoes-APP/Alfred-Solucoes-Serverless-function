import { serve } from "std/http";
import {
  applyRateLimit,
  buildConfirmationEmail,
  buildCorsHeaders,
  getBearerToken,
  handlePreflight,
  jsonResponse,
  logger,
  methodNotAllowed,
  requireAuthenticatedUser,
  getDeviceRecord,
  updateDeviceRecord,
  sendEmail,
  resolveAppBaseUrl,
} from "../_shared/mod.ts";

const DEFAULT_DEVICE_NAME = "Dispositivo desconhecido";

type CheckDeviceBody = {
  deviceId?: string;
  resend?: boolean;
};

type CheckDeviceResponse = {
  status: "approved" | "pending" | "unregistered";
  requiresConfirmation: boolean;
  device?: {
    id: string;
    name: string | null;
    confirmedAt: string | null;
    lastSeenAt: string | null;
  };
};

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

serve(async (request) => {
  const corsHeaders = buildCorsHeaders({ methods: ["POST", "OPTIONS"] });

  const preflight = handlePreflight(request, corsHeaders);
  if (preflight) {
    return preflight;
  }

  if (request.method !== "POST") {
    return methodNotAllowed(corsHeaders);
  }

  const rateLimited = applyRateLimit(request, corsHeaders, {
    identifier: "checkDeviceStatus",
    max: 30,
    windowMs: 60_000,
  });
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const token = getBearerToken(request);
    if (!token) {
      return jsonResponse({ error: "Authorization header ausente." }, { status: 401, corsHeaders });
    }

    const user = await requireAuthenticatedUser(token);

    const rawBody = await request.json().catch(() => ({})) as CheckDeviceBody;
    const deviceId = sanitizeString(rawBody.deviceId);
    if (!deviceId) {
      return jsonResponse({ error: "Identificador do dispositivo ausente." }, { status: 400, corsHeaders });
    }

    const deviceRecord = await getDeviceRecord(user.id, deviceId);
    if (!deviceRecord) {
      const response: CheckDeviceResponse = {
        status: "unregistered",
        requiresConfirmation: true,
      };
      return jsonResponse(response, { status: 200, corsHeaders });
    }

    let updatedRecord = deviceRecord;
    const requiresConfirmation = deviceRecord.status !== "approved" || !deviceRecord.confirmed_at;

    if (requiresConfirmation) {
      const resend = Boolean(rawBody.resend);
      const shouldGenerateNewToken = resend || !deviceRecord.approval_token;
      const approvalToken = shouldGenerateNewToken ? crypto.randomUUID() : deviceRecord.approval_token!;
      const updates: Record<string, unknown> = {};
      if (shouldGenerateNewToken) {
        updates.approval_token = approvalToken;
      }
      updates.status = "pending";

      if (Object.keys(updates).length > 0) {
        updatedRecord = await updateDeviceRecord(deviceRecord.id, updates);
      }

      if (shouldGenerateNewToken || resend) {
        const confirmationLink = `${resolveAppBaseUrl(request)}/confirm-device?token=${encodeURIComponent(updatedRecord.approval_token ?? approvalToken)}`;
        const email = buildConfirmationEmail({
          userName: user.email,
          confirmationLink,
          deviceName: updatedRecord.device_name ?? DEFAULT_DEVICE_NAME,
          ipAddress: updatedRecord.ip_address ?? null,
          locale: updatedRecord.locale ?? null,
          timezone: updatedRecord.timezone ?? null,
        });
        await sendEmail({ to: user.email ?? "", subject: email.subject, html: email.html, text: email.text });
      }
    }

    const response: CheckDeviceResponse = {
      status: updatedRecord.status === "approved" && updatedRecord.confirmed_at ? "approved" : "pending",
      requiresConfirmation,
      device: {
        id: updatedRecord.device_id,
        name: updatedRecord.device_name,
        confirmedAt: updatedRecord.confirmed_at,
        lastSeenAt: updatedRecord.last_seen_at,
      },
    };

    return jsonResponse(response, { status: 200, corsHeaders });
  } catch (error) {
    logger.error("checkDeviceStatus: unexpected error", { message: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: "Erro inesperado." }, { status: 500, corsHeaders });
  }
});
