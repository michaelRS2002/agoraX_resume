import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { transcribeBuffer, sendSummaryByEmail } from '../services/transcribe';
// Optional: use OpenAI-compatible SDK for DeepSeek
import OpenAI from 'openai';

const router = express.Router();

// Accept raw audio bytes (Content-Type: audio/*). Query params: roomId, userId, email (optional)
router.post('/transcribe-chunk',
  express.raw({ type: 'audio/*', limit: '15mb' }),
  async (req: Request, res: Response) => {
    try {
      const { roomId, userId, email } = req.query || {};
      const buf = req.body as Buffer;

      console.log("[audio] received", {
        roomId, userId, email,
        size: buf?.length,
        contentType: req.headers["content-type"]
      });

      if (!buf || buf.length < 4000) {
        return res.status(400).json({
          success: false,
          message: "Chunk too small"
        });
      }

      // Compute head hex for diagnostics
      const headHex = Array.from((buf as Buffer).slice(0, 12)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      // Save chunk
      const tmpDir = process.env.STORAGE_TEMP_PATH || path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const filename = `audio-${Date.now()}-${Math.random().toString(36).slice(2,8)}.webm`;
      const filePath = path.join(tmpDir, filename);

      await fs.promises.writeFile(filePath, buf);

      // Transcribe
      const transcribeResult = await transcribeBuffer(filePath);
      const transcription = transcribeResult?.transcript || '';

      console.log('[audio] transcribe result', { retried: transcribeResult.retried, transcoded: transcribeResult.transcoded });

      // Append transcription to per-room/user transcript file for session aggregation
      try {
        const transcriptsDir = path.join(tmpDir, 'transcripts');
        if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });
        const owner = String(userId || 'unknown');
        const room = String(roomId || 'global');
        const transcriptFile = path.join(transcriptsDir, `transcript-${room}-${owner}.txt`);
        // Include user identification in stored transcription lines so summaries can attribute speech
        const who = String(userId || owner || 'unknown');
        const entry = `[${new Date().toISOString()}] ${who}: ${transcription}\n`;
        await fs.promises.appendFile(transcriptFile, entry, 'utf8');
      } catch (e) {
        console.warn('[audio] failed to append transcript', e);
      }

      let summary = null;

      // Optional DeepSeek summary
      if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_BASE_URL) {
        try {
          const ds = await fetch(process.env.DEEPSEEK_BASE_URL + "/v1/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
              model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
              input: transcription
            })
          });

          if (ds.ok) {
            const json = await ds.json();
            summary = json.output || json.result || JSON.stringify(json);
          }
        } catch (err) {
          console.warn("DeepSeek summary failed", err);
        }
      }

      if (email && summary && process.env.RESEND_API_KEY) {
        try {
          await sendSummaryByEmail(
            email as string,
            `Resumen de la reunión ${roomId || ""}`,
            summary.toString()
          );
        } catch (err) {
          console.warn("Email failed:", err);
        }
      }

      await fs.promises.unlink(filePath).catch(() => {});

      res.json({ success: true, transcription, summary, retried: transcribeResult.retried, transcoded: transcribeResult.transcoded, headHex, size: buf.length });

    } catch (err: any) {
      console.error("transcribe-chunk error", err);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// Finalize: concatenate accumulated transcript for a room/user, optionally summarize with DeepSeek and email via Resend
router.post('/finalize', express.json(), async (req: Request, res: Response) => {
  try {
    const { roomId, userId, email } = req.query as any || {};
    const tmpDir = process.env.STORAGE_TEMP_PATH || path.join(process.cwd(), 'tmp');
    let transcriptsDir = path.join(tmpDir, 'transcripts');
    const room = String(roomId || 'global');
    console.log('[finalize] requested', { room, userId: userId || null, email: email || null });

    let fullText = '';
    // We'll search for transcripts in multiple candidate directories so we don't miss chat written by the older services
    const candidateDirs = [
      transcriptsDir,
      path.join(process.cwd(), '..', 'agoraX_back', 'tmp', 'transcripts'),
      path.join(process.cwd(), '..', 'AgoraX_resume', 'tmp', 'transcripts')
    ];
    let matchingFiles: string[] = [];
    try {
      for (const dir of candidateDirs) {
        try {
          if (!dir || !fs.existsSync(dir)) continue;
          const files = await fs.promises.readdir(dir);
          let found: string[] = [];
          if (userId) {
            const owner = String(userId);
            const transcriptFileName = `transcript-${room}-${owner}.txt`;
            if (files.includes(transcriptFileName)) found = [transcriptFileName];
          } else {
            found = files.filter(f => f.startsWith(`transcript-${room}-`));
          }

          if (found.length > 0) {
            // Read and concatenate files from this dir
            for (const f of found) {
              try {
                const t = await fs.promises.readFile(path.join(dir, f), 'utf8');
                fullText += `\n--- ${f} (from ${path.basename(dir)}) ---\n` + t;
                // store matchingFiles with their dir so we can cleanup later if needed
                matchingFiles.push(path.join(dir, f));
              } catch (e) {
                console.warn('[finalize] failed reading', f, e);
              }
            }
            // stop searching other dirs if we found files here (prefer first-match dir)
            break;
          }
        } catch (e) {
          // continue to next candidate dir
          continue;
        }
      }
    } catch (e) {
      console.warn('[finalize] failed to read transcript(s)', e);
    }

    const filesCount = matchingFiles.length;
    const totalChars = fullText.length;
    if (filesCount === 0) {
      console.log('[finalize] no transcripts found for room', room);
    } else {
      console.log('[finalize] aggregating transcripts', { room, filesCount, totalChars });
    }

    let summary: string | null = null;
    let deepseekStatus: number | null = null;
    // Preprocess transcript: normalize chat lines, extract participants, and mark unknown speakers
    let normalizedTranscript = fullText;
    let detectedParticipants: string[] = [];
    try {
      const rawLines = fullText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const participantsSet = new Set<string>();
      const nameRegex = /^(?:\(chat\)\s*)?([\w\-\.\s]{1,60})\s*[:：-]\s*(.+)$/i;
      const normLines = rawLines.map(line => {
        // skip transcript file headers like '--- filename ---'
        if (/^---\s*transcript-/.test(line)) return line;
        const m = line.match(nameRegex);
        if (m) {
          const name = m[1].trim();
          const msg = m[2].trim();
          participantsSet.add(name);
          return `${name}: ${msg}`;
        }
        // if line already contains '(chat)' pattern with name later, try looser match
        const chatLoose = line.match(/\(chat\)\s*([\w\-\.\s]{1,60})\s*[:：-]\s*(.+)$/i);
        if (chatLoose) {
          const name = chatLoose[1].trim();
          const msg = chatLoose[2].trim();
          participantsSet.add(name);
          return `${name}: ${msg}`;
        }
        // If line looks like just a message, mark unknown
        return `[Desconocido]: ${line}`;
      });
      normalizedTranscript = normLines.join('\n');
      detectedParticipants = Array.from(participantsSet);
    } catch (e) {
      console.warn('[finalize] transcript preprocessing failed', e);
      normalizedTranscript = fullText;
      detectedParticipants = [];
    }

    if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_BASE_URL && normalizedTranscript && normalizedTranscript.trim().length > 0) {
      // Prefer using the official OpenAI JS SDK (compatible with DeepSeek) if available.
      try {
        console.log('[finalize] calling DeepSeek via OpenAI SDK', { model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', charCount: fullText.length, filesCount });
        const client = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: process.env.DEEPSEEK_BASE_URL });

        try {
          // Use chat completions API as shown in DeepSeek docs
          // Build a structured Spanish prompt requesting the exact summary format
          const systemPrompt = `Eres un asistente que genera resúmenes ejecutivos en español para reuniones académicas y de equipo. ` +
            `Trata la entrada como una TRANSCRIPCIÓN literal de audio/chat. No inventes participantes ni atribuyas declaraciones a personas que no aparecen nombradas en la transcripción. ` +
            `Si una intervención no tiene un nombre claro, indícalo con "[Desconocido]". Devuelve SOLO el resumen estructurado en texto (puedes usar Markdown simple) con las secciones solicitadas; NO incluyas ninguna frase que haga referencia a "Enviar por correo" o instrucciones de envío. ` +
            `Siempre responde en español; evita opiniones o cualquier contenido no presente en la transcripción.`;

          const participantsText = detectedParticipants.length ? detectedParticipants.join(', ') : 'Ninguno identificado';

          const userPrompt = `Participantes detectados: ${participantsText}\n\n` +
            `Transcripción de la sesión:\n\n${normalizedTranscript}\n\n` +
            `Notas sobre formato:\n` +
            `- La transcripción puede contener timestamps y entradas de chat en formato "(chat) Nombre: mensaje".\n` +
            `- No inventes nombres ni atribuciones; si no se puede identificar, usa "[Desconocido]".\n` +
            `- Mantén la salida en las siguientes secciones exactas (en este orden):\n` +
            `  1) Participantes — lista los nombres/identificadores que aparezcan.\n` +
            `  2) Resumen del chat — sintetiza las ideas principales, anteponiendo el nombre cuando esté disponible (ej.: "Michael: ..."). Usa "[Desconocido]:" cuando no haya nombre.\n` +
            `  3) Tareas/Compromisos — una lista de viñetas con acciones concretas y responsables si se identifican.\n` +
            `- No agregues introducciones generales ni conclusiones del tipo "Se envía este resumen...".\n` +
            `- Usa un tono profesional y claro; mantén la longitud razonable.`;

          const completion: any = await (client as any).chat.completions.create({
            model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 1200
          });

          // SDK may return choices with message content
          const choice = completion?.choices && completion.choices[0];
          const content = choice?.message?.content || choice?.text || completion?.output || null;
          if (content) {
            summary = typeof content === 'string' ? content : JSON.stringify(content);
            deepseekStatus = 200;
          } else {
            console.warn('[finalize] DeepSeek SDK returned unexpected shape', { completion });
            // fallback to extractive
            const lines = fullText.split('\n').map(s => s.trim()).filter(Boolean);
            summary = `[Fallback summary due to DeepSeek unexpected shape]\n` + lines.slice(0, 8).join(' ').slice(0, 2000);
          }
        } catch (sdkErr: any) {
          console.warn('[finalize] DeepSeek SDK call failed', sdkErr && sdkErr.stack ? sdkErr.stack : sdkErr);
          // If SDK call failed (404 or other), try the raw HTTP endpoint as a secondary attempt
          try {
            const ds = await fetch(process.env.DEEPSEEK_BASE_URL.replace(/\/+$/,'') + '/v1/responses', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
              },
              body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', input: fullText })
            });
            deepseekStatus = ds.status;
            const bodyText = await ds.text();
            if (ds.ok) {
              let parsed: any = null;
              try { parsed = JSON.parse(bodyText); } catch (e) { parsed = bodyText; }
              summary = parsed?.output || parsed?.result || (typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
            } else {
              console.warn('[finalize] DeepSeek returned non-ok (raw HTTP)', { status: ds.status, body: bodyText?.slice?.(0,2000) });
              const lines = fullText.split('\n').map(s => s.trim()).filter(Boolean);
              const fallback = lines.slice(0, 8).join(' ');
              summary = `[Fallback summary due to DeepSeek error (status ${ds.status})]\n` + fallback.slice(0, 2000);
            }
          } catch (e2) {
            const e2Msg = e2 instanceof Error ? e2.stack : String(e2);
            console.warn('[finalize] DeepSeek raw HTTP fallback failed', e2Msg);
            const lines = fullText.split('\n').map(s => s.trim()).filter(Boolean);
            summary = `[Fallback summary due to DeepSeek exception]\n` + lines.slice(0, 8).join(' ').slice(0, 2000);
          }
        }

      } catch (e: any) {
        console.warn('[finalize] DeepSeek overall call failed', e && e.stack ? e.stack : e);
        const lines = fullText.split('\n').map(s => s.trim()).filter(Boolean);
        summary = `[Fallback summary due to DeepSeek exception]\n` + lines.slice(0, 8).join(' ').slice(0, 2000);
      }
    }

    // Optionally email: if `email` query provided, send to that address.
    if (email && summary && process.env.RESEND_API_KEY) {
      try {
        console.log('[finalize] attempting to send summary to explicit email', { to: email, room });
        await sendSummaryByEmail(email as string, `Resumen reunión ${room || ''}`, summary);
        console.log('[finalize] sendSummaryByEmail succeeded for explicit email', { to: email, room });
        // Delete transcript files after successful send
        for (const fPath of matchingFiles) {
          try { await fs.promises.unlink(fPath); } catch (e) { /* ignore */ }
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.stack : String(e);
        console.warn('[finalize] sendSummaryByEmail failed for explicit email', { to: email, err: errMsg });
      }
    } else if (!email && summary && process.env.RESEND_API_KEY) {
      // No explicit email provided: try to fetch meeting participants from backend and email them
      try {
        const backend = process.env.BACKEND_BASE || '';
        if (backend) {
          const url = `${backend.replace(/\/+$/,'')}/api/meetings/${encodeURIComponent(room)}`;
          const resp = await fetch(url, { method: 'GET' as any });
          if (resp.ok) {
            const body = await resp.json();
            const participants: string[] = (body?.meeting?.participantsEmails) || [];
            if (participants && participants.length) {
              let allSent = true;
              for (const addr of participants) {
                try {
                  console.log('[finalize] attempting to send summary to participant', { to: addr, room });
                  await sendSummaryByEmail(addr, `Resumen reunión ${room || ''}`, summary);
                  console.log('[finalize] emailed summary to', addr);
                } catch (e) {
                  allSent = false;
                  const errMsg = e instanceof Error ? e.stack : String(e);
                  const errMsgShort = e instanceof Error ? e.message : String(e);
                  console.warn('[finalize] failed emailing to participant', addr, errMsg);
                }
              }
              // Delete transcript files only if all emails sent successfully
              if (allSent) {
                for (const fPath of matchingFiles) {
                  try { await fs.promises.unlink(fPath); } catch (e) { /* ignore */ }
                }
              }
            } else {
              console.log('[finalize] no participantsEmails found on meeting');
            }
          } else {
            console.warn('[finalize] failed fetching meeting participants', { status: resp.status });
          }
        } else {
          console.log('[finalize] BACKEND_BASE not configured; attempting email-extraction fallback from transcript text');
          try {
            // Try to extract email addresses from the aggregated fullText as a last-resort fallback
            const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
            const found = (fullText || '').match(emailRegex) || [];
            const unique = Array.from(new Set(found));
            if (unique.length) {
              console.log('[finalize] extracted recipient emails from transcript', { count: unique.length, recipients: unique });
              let allSent = true;
              for (const addr of unique) {
                try {
                  console.log('[finalize] attempting to send summary to extracted email', { to: addr, room });
                  await sendSummaryByEmail(addr, `Resumen reunión ${room || ''}`, summary);
                  console.log('[finalize] emailed summary to (extracted)', addr);
                } catch (e) {
                  allSent = false;
                  const errMsg = e instanceof Error ? e.stack : String(e);
                  console.warn('[finalize] failed emailing to extracted participant', addr, errMsg);
                }
              }
              // Delete transcript files only if all emails sent successfully
              if (allSent) {
                for (const fPath of matchingFiles) {
                  try { await fs.promises.unlink(fPath); } catch (e) { /* ignore */ }
                }
              }
            } else {
              console.log('[finalize] no email addresses found in transcript text; skipping delivery');
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.stack : String(e);
            console.warn('[finalize] email-extraction fallback failed', errMsg);
          }
        }
      } catch (e) {
        console.warn('[finalize] error while attempting to email participants', e);
      }
    }

    // Log the generated summary to the server console (preview + full)
    try {
      if (summary && summary.length > 0) {
        console.log('[finalize] summary preview', summary.slice(0, 2000));
        console.log('[finalize] full summary', summary);
      } else {
        console.log('[finalize] no summary generated');
      }
    } catch (e) {
      console.warn('[finalize] failed logging summary', e);
    }

    res.json({ success: true, fullText, summary, deepseekStatus });
  } catch (err: any) {
    console.error('finalize error', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Diagnostics: list transcript files for a room and return a short preview of each
router.get('/diagnostics', async (req: Request, res: Response) => {
  try {
    const { roomId } = req.query as any || {};
    const room = String(roomId || 'global');
    const tmpDir = process.env.STORAGE_TEMP_PATH || path.join(process.cwd(), 'tmp');
    const candidateDirs = [
      path.join(tmpDir, 'transcripts'),
      path.join(process.cwd(), '..', 'agoraX_back', 'tmp', 'transcripts'),
      path.join(process.cwd(), '..', 'AgoraX_resume', 'tmp', 'transcripts')
    ];

    const results: Array<{ dir: string; files: Array<{ name: string; preview: string }> }> = [];

    for (const dir of candidateDirs) {
      try {
        if (!dir || !fs.existsSync(dir)) continue;
        const files = await fs.promises.readdir(dir);
        const matched = files.filter(f => f.startsWith(`transcript-${room}-`));
        if (!matched.length) continue;
        const filesData: Array<{ name: string; preview: string }> = [];
        for (const f of matched) {
          try {
            const full = await fs.promises.readFile(path.join(dir, f), 'utf8');
            const preview = full.split(/\r?\n/).slice(0, 8).join('\n').slice(0, 2000);
            filesData.push({ name: f, preview });
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            filesData.push({ name: f, preview: `Failed to read: ${errMsg}` });
          }
        }
        results.push({ dir, files: filesData });
      } catch (e) {
        continue;
      }
    }

    res.json({ success: true, room, results });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Test email endpoint: send a test meeting summary/email to verify Resend configuration
router.post('/test-email', express.json(), async (req: Request, res: Response) => {
  try {
    const { to, subject, body, participants } = req.body || {};
    if (!to) return res.status(400).json({ success: false, message: 'to is required' });
    if (!process.env.RESEND_API_KEY) return res.status(500).json({ success: false, message: 'RESEND_API_KEY not configured' });

    try {
      await sendSummaryByEmail(String(to), String(subject || 'Prueba de AgoraX: correo de resumen'), String(body || 'Este es un correo de prueba desde AgoraX_resume.'), Array.isArray(participants) ? participants : undefined);
      return res.json({ success: true, message: 'Test email sent (attempted). Check logs and spam folder.' });
    } catch (err: any) {
      console.warn('[test-email] send error', err);
      return res.status(500).json({ success: false, message: String(err?.message || err) });
    }
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
