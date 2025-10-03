type LogLevel = "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

function serializeMessage(level: LogLevel, message: string, context: LogContext): string {
	return JSON.stringify({
		timestamp: new Date().toISOString(),
		level,
		message,
		...context,
	});
}

function write(level: LogLevel, message: string, context: LogContext = {}): void {
	const payload = serializeMessage(level, message, context);
	if (level === "error") {
		console.error(payload);
		return;
	}
	if (level === "warn") {
		console.warn(payload);
		return;
	}
	console.log(payload);
}

export const logger = {
	info(message: string, context: LogContext = {}): void {
		write("info", message, context);
	},
	warn(message: string, context: LogContext = {}): void {
		write("warn", message, context);
	},
	error(message: string, context: LogContext = {}): void {
		write("error", message, context);
	},
	withContext(base: LogContext) {
		return {
			info(message: string, context: LogContext = {}) {
				write("info", message, { ...base, ...context });
			},
			warn(message: string, context: LogContext = {}) {
				write("warn", message, { ...base, ...context });
			},
			error(message: string, context: LogContext = {}) {
				write("error", message, { ...base, ...context });
			},
		};
	},
};

export type { LogContext, LogLevel };
