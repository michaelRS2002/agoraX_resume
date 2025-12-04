import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY || '');

/**
 * Envía el resumen de una reunión usando la plantilla de AgoraX.
 * @param to dirección del destinatario
 * @param subject asunto
 * @param summary contenido HTML o texto
 * @param participants lista de participantes opcional
 */
export async function sendMeetingSummaryEmail(to: string, subject: string, summary: string, participants?: string[]) {
  // Remove common unwanted intro lines (e.g., "Para quienes me han preguntado..." until the send line)
  let cleaned = String(summary || '').trim();
  const introPattern = /Para quienes[\s\S]*?Se envía este resumen por correo a los participantes\.?\s*/i;
  cleaned = cleaned.replace(introPattern, '').trim();

  // Convert a minimal subset of markdown/plain text to safe HTML
  function simpleMarkdownToHtml(text: string) {
    // escape first
    let s = escapeHtml(text);
    // bold **text**
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // unordered lists: lines starting with * or -
    const lines = s.split(/\r?\n/);
    const out: string[] = [];
    let inUl = false;
    for (let line of lines) {
      const trimmed = line.trim();
      if (/^([\*\-])\s+/.test(trimmed)) {
        if (!inUl) { out.push('<ul style="margin:8px 0 8px 18px;color:#222;">'); inUl = true; }
        const li = trimmed.replace(/^([\*\-])\s+/, '');
        out.push(`<li>${li}</li>`);
      } else {
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (trimmed === '') { out.push('<p></p>'); }
        else { out.push(`<p style="margin:8px 0;color:#222;">${trimmed}</p>`); }
      }
    }
    if (inUl) out.push('</ul>');
    return out.join('\n');
  }

  const participantsHtml = participants && participants.length ? `
    <div style="margin-bottom:16px;">
      <h3 style="margin:0 0 8px 0;color:#333;">Participantes</h3>
      <ul style="margin:0;padding-left:18px;color:#333;">
        ${participants.map(p => `<li>${escapeHtml(String(p))}</li>`).join('')}
      </ul>
    </div>
  ` : '';

  const summaryHtml = simpleMarkdownToHtml(cleaned);

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; padding: 22px; background-color: #f6f8fb;">
      <div style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:10px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <div style="text-align:center; margin-bottom:14px;">
          <h1 style="color:#111; margin:0; font-size:20px;">Resumen de la reunión</h1>
        </div>
        ${participantsHtml}
        <div style="padding:12px 14px; border-radius:8px; background:#fafafa;">
          ${summaryHtml}
        </div>
        <div style="margin-top:14px; font-size:13px; color:#666;">Este es un mensaje automático de AgoraX.</div>
      </div>
    </div>
  `;

  try {
    await resend.emails.send({
      from:'AgoraX <noreply@messagesmail.store>',
      to,
      subject,
      html: htmlContent,
    } as any);
    console.log('✅ Resumen enviado a', to);
    // Persist a short log to disk so the operator can check deliveries after the fact
    try {
      const logDir = process.env.MAIL_LOG_PATH || (process.cwd() + '/tmp');
      const logFile = logDir.replace(/\/+$/,'') + '/mail.log';
      try { require('fs').mkdirSync(logDir, { recursive: true }); } catch(e) {}
      const entry = `[${new Date().toISOString()}] SENT to=${to} subject=${subject}\n`;
      require('fs').appendFileSync(logFile, entry, 'utf8');
    } catch (e) {
      console.warn('Failed to write mail log', e);
    }
  } catch (err) {
    console.warn('Failed to send meeting summary via Resend', err);
    try {
      const logDir = process.env.MAIL_LOG_PATH || (process.cwd() + '/tmp');
      const logFile = logDir.replace(/\/+$/,'') + '/mail.log';
      try { require('fs').mkdirSync(logDir, { recursive: true }); } catch(e) {}
      const entry = `[${new Date().toISOString()}] FAILED to=${to} subject=${subject} err=${String(err?.message || err)}\n`;
      require('fs').appendFileSync(logFile, entry, 'utf8');
    } catch(e) {}
    throw err;
  }
}

/**
 * Envia correo de restablecimiento (mantengo esta utilidad por compatibilidad).
 */
export async function sendResetPasswordEmail(to: string, token: string) {
  const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #ffffff;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #333; margin: 0;">AgoraX</h1>
      </div>
      
      <div style="background-color: #e7e7e7; padding: 30px; border-radius: 8px;">
        <h2 style="color: #333; margin-top: 0;">Restablecer Contraseña</h2>
        <p>Hola,</p>
        <p>Recibimos una solicitud para restablecer tu contraseña en AgoraX.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #000000; color: #ffffff; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">Restablecer Contraseña</a>
        </div>
        <div style="background-color: #d9d9d9; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p style="margin: 0; color: #333;"><strong>⚠️ Importante:</strong></p>
          <ul style="color: #333; margin: 10px 0;">
            <li>Este enlace expirará en <strong>15 minutos</strong> por seguridad</li>
            <li>Solo puedes usar este enlace una vez</li>
            <li>Si no solicitaste este cambio, ignora este email</li>
          </ul>
        </div>
      </div>
      <hr style="border: none; border-top: 1px solid #e7e7e7; margin: 30px 0;">
      <p style="color: #999; font-size: 12px;">Este es un mensaje automático de AgoraX. Por favor, no respondas a este email.</p>
      <p style="color: #999; font-size: 12px;">Si tienes problemas con el enlace, copia y pega esta URL en tu navegador:<br><span style="word-break: break-all;">${resetLink}</span></p>
    </div>
  `;

  await resend.emails.send({
    from: process.env.MAIL_FROM || 'AgoraX <noreply@messagesmail.store>',
    to,
    subject: 'Restablecer Contraseña - AgoraX',
    html: htmlContent,
  });

  console.log('✅ Correo de restablecimiento enviado a', to);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
