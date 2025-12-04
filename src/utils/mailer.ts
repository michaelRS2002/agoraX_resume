import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY || '');

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('❌ Error enviando resumen:', errMsg);
    throw err;
  }
}
