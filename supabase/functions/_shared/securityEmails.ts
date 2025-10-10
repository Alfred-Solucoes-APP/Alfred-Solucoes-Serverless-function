type EmailContent = {
	subject: string;
	html: string;
	text: string;
};

export function buildConfirmationEmail(params: {
	userName?: string | null;
	confirmationLink: string;
	deviceName: string;
	ipAddress: string | null;
	locale: string | null;
	timezone: string | null;
}): EmailContent {
	const subject = "Confirme o novo dispositivo";
	const greeting = params.userName ? `Olá, ${params.userName}!` : "Olá!";
	const html = `
    <p>${greeting}</p>
    <p>Detectamos um acesso a partir de um novo dispositivo (<strong>${params.deviceName}</strong>).</p>
    <p>Para concluir o login, confirme clicando no botão abaixo:</p>
    <p><a href="${params.confirmationLink}" style="display:inline-block;padding:12px 20px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:6px;">Confirmar dispositivo</a></p>
    <p>Detalhes do acesso:</p>
    <ul>
      ${params.ipAddress ? `<li><strong>IP:</strong> ${params.ipAddress}</li>` : ""}
      ${params.locale ? `<li><strong>Idioma:</strong> ${params.locale}</li>` : ""}
      ${params.timezone ? `<li><strong>Fuso horário:</strong> ${params.timezone}</li>` : ""}
    </ul>
    <p>Se você não reconhece este acesso, recomendamos alterar sua senha imediatamente.</p>
  `;
	const text = `${greeting}

Detectamos um acesso a partir de um novo dispositivo (${params.deviceName}).

Para concluir o login, confirme em: ${params.confirmationLink}

Detalhes do acesso:
${params.ipAddress ? `- IP: ${params.ipAddress}\n` : ""}${params.locale ? `- Idioma: ${params.locale}\n` : ""}${params.timezone ? `- Fuso horário: ${params.timezone}\n` : ""}

Se você não reconhece este acesso, altere sua senha imediatamente.`;

	return { subject, html, text };
}

export function buildLoginEmail(params: {
	userName?: string | null;
	deviceName: string;
	ipAddress: string | null;
	locale: string | null;
	timezone: string | null;
	createdAt: Date;
}): EmailContent {
	const subject = "Novo login detectado";
	const greeting = params.userName ? `Olá, ${params.userName}!` : "Olá!";
	const formattedDate = params.createdAt.toLocaleString("pt-BR", { timeZone: params.timezone ?? "UTC" });
	const html = `
    <p>${greeting}</p>
    <p>Um novo login foi realizado em sua conta.</p>
    <ul>
      <li><strong>Dispositivo:</strong> ${params.deviceName}</li>
      <li><strong>Data e hora:</strong> ${formattedDate}</li>
      ${params.ipAddress ? `<li><strong>IP:</strong> ${params.ipAddress}</li>` : ""}
      ${params.locale ? `<li><strong>Idioma:</strong> ${params.locale}</li>` : ""}
      ${params.timezone ? `<li><strong>Fuso horário:</strong> ${params.timezone}</li>` : ""}
    </ul>
    <p>Se não foi você, altere sua senha imediatamente.</p>
  `;
	const text = `${greeting}

Um novo login foi realizado em sua conta.
- Dispositivo: ${params.deviceName}
- Data e hora: ${formattedDate}
${params.ipAddress ? `- IP: ${params.ipAddress}\n` : ""}${params.locale ? `- Idioma: ${params.locale}\n` : ""}${params.timezone ? `- Fuso horário: ${params.timezone}\n` : ""}

Se não foi você, altere sua senha imediatamente.`;

	return { subject, html, text };
}
