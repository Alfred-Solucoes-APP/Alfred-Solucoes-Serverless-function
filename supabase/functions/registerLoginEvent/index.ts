import { serve } from "std/http";
import {
  applyRateLimit,
  buildCorsHeaders,
  getBearerToken,
  getClientIp,
  handlePreflight,
  jsonResponse,
  logger,
  methodNotAllowed,
  recordLoginEvent,
  requireAuthenticatedUser,
  sendEmail,
  upsertDeviceRecord,
  updateDeviceRecord,
  getDeviceRecord,
  buildConfirmationEmail,
  buildLoginEmail,
  resolveAppBaseUrl,
} from "../_shared/mod.ts";

const DEFAULT_DEVICE_NAME = "Dispositivo desconhecido";

type RegisterLoginBody = {
  deviceId?: string;
  deviceName?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  screen?: string;
  resend?: boolean;
};

type RegisterLoginResponse = {
  status: "approved" | "pending";
  requiresConfirmation: boolean;
  device: {
    id: string;
    name: string | null;
    lastSeenAt: string | null;
    confirmedAt: string | null;
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
    identifier: "registerLoginEvent",
    max: 20,
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

    const rawBody = await request.json().catch(() => ({})) as RegisterLoginBody;
    const deviceId = sanitizeString(rawBody.deviceId);
    if (!deviceId) {
      return jsonResponse({ error: "Identificador do dispositivo ausente." }, { status: 400, corsHeaders });
    }

    const deviceName = sanitizeString(rawBody.deviceName) ?? DEFAULT_DEVICE_NAME;
    const userAgent = sanitizeString(rawBody.userAgent) ?? null;
    const locale = sanitizeString(rawBody.locale) ?? null;
    const timezone = sanitizeString(rawBody.timezone) ?? null;
    const screen = sanitizeString(rawBody.screen) ?? null;
    const resend = Boolean(rawBody.resend);

    const ipAddress = getClientIp(request);
    const now = new Date();

    await recordLoginEvent({
      userId: user.id,
      deviceId,
      deviceName,
      ipAddress,
      userAgent,
      locale,
      timezone,
      metadata: { screen },
    });

    let deviceRecord = await getDeviceRecord(user.id, deviceId);
    let requiresConfirmation = false;

    if (!deviceRecord) {
      const approvalToken = crypto.randomUUID();
      deviceRecord = await upsertDeviceRecord({
        user_id: user.id,
        device_id: deviceId,
        device_name: deviceName,
        user_agent: userAgent,
        ip_address: ipAddress,
        locale,
        timezone,
        screen,
        status: "pending",
        approval_token: approvalToken,
        last_seen_at: now.toISOString(),
        confirmed_at: null,
      });
      requiresConfirmation = true;

      const confirmationLink = `${resolveAppBaseUrl(request)}/confirm-device?token=${encodeURIComponent(approvalToken)}`;
      const email = buildConfirmationEmail({
        userName: user.email,
        confirmationLink,
        deviceName,
        ipAddress,
        locale,
        timezone,
      });
      await sendEmail({ to: user.email ?? "", subject: email.subject, html: email.html, text: email.text });
    } else {
      const updates: Record<string, unknown> = {
        last_seen_at: now.toISOString(),
      };
      if (deviceName && deviceName !== deviceRecord.device_name) {
        updates.device_name = deviceName;
      }
      if (userAgent && userAgent !== deviceRecord.user_agent) {
        updates.user_agent = userAgent;
      }
      if (ipAddress && ipAddress !== deviceRecord.ip_address) {
        updates.ip_address = ipAddress;
      }
      if (locale && locale !== deviceRecord.locale) {
        updates.locale = locale;
      }
      if (timezone && timezone !== deviceRecord.timezone) {
        updates.timezone = timezone;
      }
      if (screen && screen !== deviceRecord.screen) {
        updates.screen = screen;
      }

      if (deviceRecord.status !== "approved" || !deviceRecord.confirmed_at) {
        requiresConfirmation = true;
        const approvalToken = deviceRecord.approval_token ?? crypto.randomUUID();
        updates.approval_token = approvalToken;
        updates.status = "pending";
        const confirmationLink = `${resolveAppBaseUrl(request)}/confirm-device?token=${encodeURIComponent(approvalToken)}`;
        const email = buildConfirmationEmail({
          userName: user.email,
          confirmationLink,
          deviceName,
          ipAddress,
          locale,
          timezone,
        });
        await sendEmail({ to: user.email ?? "", subject: email.subject, html: email.html, text: email.text });
      } else {
        const email = buildLoginEmail({
          userName: user.email,
          deviceName: deviceName ?? DEFAULT_DEVICE_NAME,
          ipAddress,
          locale,
          timezone,
          createdAt: now,
        });
        await sendEmail({ to: user.email ?? "", subject: email.subject, html: email.html, text: email.text });
      }

      deviceRecord = await updateDeviceRecord(deviceRecord.id, updates);
    }

    const response: RegisterLoginResponse = {
      status: deviceRecord.status === "approved" && deviceRecord.confirmed_at ? "approved" : "pending",
      requiresConfirmation,
      device: {
        id: deviceRecord.device_id,
        name: deviceRecord.device_name,
        lastSeenAt: deviceRecord.last_seen_at,
        confirmedAt: deviceRecord.confirmed_at,
      },
    };

    return jsonResponse(response, { status: 200, corsHeaders });
  } catch (error) {
    logger.error("registerLoginEvent: unexpected error", { message: error instanceof Error ? error.message : String(error) });
    return jsonResponse({ error: "Erro inesperado." }, { status: 500, corsHeaders });
  }
});
