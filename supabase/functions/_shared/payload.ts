export type JsonRecord = Record<string, unknown>;

export function parseJsonObjectField(value: unknown, fieldName: string): JsonRecord | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as JsonRecord;
			}
			throw new Error("O JSON deve representar um objeto.");
		} catch (error) {
			throw new Error(`Campo '${fieldName}' não contém um JSON válido: ${(error as Error).message}`);
		}
	}

	if (typeof value === "object" && !Array.isArray(value)) {
		return value as JsonRecord;
	}

	throw new Error(`Campo '${fieldName}' deve ser um objeto JSON.`);
}

export function parseAllowedRoles(value: unknown, fallback: string[] = ["user", "authenticated"]): string[] {
	const normalizeRoles = (roles: string[]): string[] => {
		const unique = new Set<string>();
		for (const role of roles) {
			const trimmed = role.trim();
			if (trimmed.length > 0) {
				unique.add(trimmed);
			}
		}

		if (unique.size === 0) {
			for (const item of fallback) {
				unique.add(item);
			}
		}

		return Array.from(unique);
	};

	if (value === null || value === undefined || value === "") {
		return [...fallback];
	}

	if (Array.isArray(value)) {
		const roles = value.map((item) => (typeof item === "string" ? item : String(item)));
		return normalizeRoles(roles);
	}

	if (typeof value === "string") {
		return normalizeRoles(value.split(","));
	}

	return normalizeRoles([String(value)]);
}

export function normalizeSlug(
	slug: string,
	options: { resourceName?: string; fieldLabel?: string } = {},
): string {
	const { resourceName = "recurso", fieldLabel = "slug" } = options;
	const trimmed = slug.trim();
	if (!trimmed) {
		throw new Error(`${fieldLabel} do ${resourceName} é obrigatório.`);
	}
	return trimmed.toLowerCase().replace(/\s+/g, "_");
}

export function ensureNonEmptyString(
	value: string,
	options: { fieldLabel?: string } = {},
): string {
	const { fieldLabel = "Campo" } = options;
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${fieldLabel} é obrigatório.`);
	}
	return trimmed;
}

export function parsePrimaryKey(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string" && value.trim() !== "") {
		return value.trim();
	}
	return null;
}
