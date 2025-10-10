import { logger } from "./logging.ts";

export type SendEmailOptions = {
	to: string;
	subject: string;
	html?: string;
	text?: string;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";

type ResendResponse = {
	id: string;
};

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
	const apiKey = Deno.env.get("RESEND_API_KEY");
	const fromEmail = Deno.env.get("SECURITY_EMAIL_FROM") ?? Deno.env.get("RESEND_FROM_EMAIL");

	if (!apiKey || !fromEmail) {
		logger.warn("Email service not configured. Skipping email send.", {
			hasApiKey: Boolean(apiKey),
			hasFromEmail: Boolean(fromEmail),
			subject: options.subject,
		});
		return false;
	}

	const payload = {
		from: fromEmail,
		to: [options.to],
		subject: options.subject,
		html: options.html,
		text: options.text,
	};

	const response = await fetch(RESEND_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const body = await response.text();
		logger.error("Failed to send email", {
			status: response.status,
			statusText: response.statusText,
			body,
		});
		return false;
	}

	const body = (await response.json()) as ResendResponse;
	logger.info("Email sent", { id: body.id, subject: options.subject });
	return true;
}
