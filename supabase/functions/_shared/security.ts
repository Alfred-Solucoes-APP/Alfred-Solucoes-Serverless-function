import { createClient, type User } from "supabase";
import { logger } from "./logging.ts";

export type DeviceRecord = {
	id: string;
	user_id: string;
	device_id: string;
	device_name: string | null;
	user_agent: string | null;
	ip_address: string | null;
	locale: string | null;
	timezone: string | null;
	screen: string | null;
	status: string;
	approval_token: string | null;
	confirmed_at: string | null;
	last_seen_at: string | null;
	created_at: string;
	updated_at: string;
};

export type LoginEventPayload = {
	userId: string;
	deviceId: string | null;
	deviceName?: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	locale?: string | null;
	timezone?: string | null;
	metadata?: Record<string, unknown> | null;
};

function getServiceClient() {
	const url = Deno.env.get("SUPABASE_URL") ?? "";
	const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

	if (!url || !serviceKey) {
		logger.error("Supabase service credentials missing for security helper", {
			hasUrl: Boolean(url),
			hasKey: Boolean(serviceKey),
		});
		throw new Error("Serviço mal configurado. Variáveis de ambiente do Supabase ausentes.");
	}

	return createClient(url, serviceKey);
}

export async function getAuthUserById(userId: string): Promise<User | null> {
	const serviceClient = getServiceClient();
	const { data, error } = await serviceClient.auth.admin.getUserById(userId);
	if (error) {
		logger.error("Failed to load auth user", { userId, error: error.message });
		return null;
	}
	return data.user ?? null;
}

export async function getDeviceRecord(userId: string, deviceId: string): Promise<DeviceRecord | null> {
	const serviceClient = getServiceClient();
	const { data, error } = await serviceClient
		.from<DeviceRecord>("security_user_devices")
		.select("*")
		.eq("user_id", userId)
		.eq("device_id", deviceId)
		.maybeSingle();

	if (error) {
		logger.error("Failed to fetch device record", { userId, deviceId, error: error.message });
		throw new Error("Erro ao validar dispositivo do usuário.");
	}

	return data ?? null;
}

export async function getDeviceRecordByToken(token: string): Promise<DeviceRecord | null> {
	const serviceClient = getServiceClient();
	const { data, error } = await serviceClient
		.from<DeviceRecord>("security_user_devices")
		.select("*")
		.eq("approval_token", token)
		.maybeSingle();

	if (error) {
		logger.error("Failed to fetch device by token", { error: error.message });
		throw new Error("Erro ao validar token do dispositivo.");
	}

	return data ?? null;
}

export async function upsertDeviceRecord(record: Partial<DeviceRecord> & { user_id: string; device_id: string }): Promise<DeviceRecord> {
	const serviceClient = getServiceClient();
	const payload = { ...record, updated_at: new Date().toISOString() };
	const { data, error } = await serviceClient
		.from<DeviceRecord>("security_user_devices")
		.upsert(payload, { onConflict: "user_id,device_id" })
		.select("*")
		.single();

	if (error || !data) {
		logger.error("Failed to upsert device record", {
			error: error?.message ?? null,
			userId: record.user_id,
			deviceId: record.device_id,
		});
		throw new Error("Erro ao registrar dispositivo.");
	}

	return data;
}

export async function updateDeviceRecord(id: string, updates: Partial<DeviceRecord>): Promise<DeviceRecord> {
	const serviceClient = getServiceClient();
	const payload = { ...updates, updated_at: new Date().toISOString() };
	const { data, error } = await serviceClient
		.from<DeviceRecord>("security_user_devices")
		.update(payload)
		.eq("id", id)
		.select("*")
		.single();

	if (error || !data) {
		logger.error("Failed to update device record", { id, error: error?.message ?? null });
		throw new Error("Erro ao atualizar dispositivo.");
	}

	return data;
}

export async function recordLoginEvent(payload: LoginEventPayload): Promise<void> {
	const serviceClient = getServiceClient();
	const { error } = await serviceClient.from("security_login_events").insert({
		user_id: payload.userId,
		device_id: payload.deviceId,
		device_name: payload.deviceName ?? null,
		ip_address: payload.ipAddress ?? null,
		user_agent: payload.userAgent ?? null,
		locale: payload.locale ?? null,
		timezone: payload.timezone ?? null,
		metadata: payload.metadata ?? null,
	});

	if (error) {
		logger.error("Failed to record login event", { error: error.message, userId: payload.userId });
	}
}

export function getClientDeviceId(request: Request): string | null {
	const header = request.headers.get("x-client-device-id") ?? request.headers.get("X-Client-Device-Id");
	if (!header) {
		return null;
	}
	const trimmed = header.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function resolveAppBaseUrl(request: Request): string {
	const envUrl = Deno.env.get("SECURITY_DEVICE_CONFIRM_URL") ?? Deno.env.get("APP_BASE_URL");
	if (envUrl) {
		return envUrl.replace(/\/$/, "");
	}
	const origin = request.headers.get("origin") ?? request.headers.get("referer") ?? "";
	if (origin) {
		try {
			const url = new URL(origin);
			url.pathname = "";
			url.search = "";
			url.hash = "";
			return url.toString().replace(/\/$/, "");
		} catch {
			logger.warn("Unable to parse request origin for device confirmation", { origin });
		}
	}
	return "http://localhost:5173";
}

export async function requireApprovedDevice(userId: string, deviceId: string | null): Promise<DeviceRecord> {
	if (!deviceId) {
		logger.warn("Missing device id in protected request", { userId });
		throw new Error("Dispositivo não autorizado. Realize a confirmação por e-mail.");
	}

	const record = await getDeviceRecord(userId, deviceId);

	if (!record || record.status !== "approved" || !record.confirmed_at) {
		logger.warn("Device not approved", { userId, deviceId, hasRecord: Boolean(record) });
		throw new Error("Dispositivo não autorizado. Realize a confirmação por e-mail.");
	}

	return record;
}
