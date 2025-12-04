import fs from 'fs';
import path from 'path';
import { Resend } from 'resend';
import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'child_process';

// Default base from Groq docs (OpenAI-compatible path)
const GROQ_BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'whisper-large-v3-turbo';

export async function transcribeBuffer(filePath: string): Promise<{ transcript: string; retried: boolean; transcoded: boolean }> {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not configured');

  try {
    const stats = fs.statSync(filePath);
    console.log('[transcribe] DEBUG: file size =', stats.size, { filePath });
  } catch (e) {
    console.warn('[transcribe] DEBUG: could not stat file', filePath, e);
  }

  const shouldTranscode = (process.env.TRANSCODE_ON_SERVER || 'false').toLowerCase() === 'true';

  // Helper to build multipart body and headers
  const buildMultipart = async (sendFilePath: string) => {
    const fileBuf = await fs.promises.readFile(sendFilePath);
    const boundary = '----NodeMultipartBoundary' + Math.random().toString(36).slice(2);
    const delimiter = `--${boundary}\r\n`;
    const closeDelimiter = `--${boundary}--\r\n`;

    const fileName = path.basename(sendFilePath);
    const contentType = path.extname(sendFilePath).toLowerCase() === '.wav' ? 'audio/wav' : 'audio/webm';

    const parts: Buffer[] = [];
    parts.push(Buffer.from(delimiter));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
    parts.push(Buffer.from(`Content-Type: ${contentType}\r\n\r\n`));
    parts.push(fileBuf);
    parts.push(Buffer.from('\r\n'));

    parts.push(Buffer.from(delimiter));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`));
    parts.push(Buffer.from(String(GROQ_MODEL) + '\r\n'));

    parts.push(Buffer.from(closeDelimiter));

    const body = Buffer.concat(parts);
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
      Authorization: `Bearer ${GROQ_KEY}`,
    } as Record<string,string>;

    return { body, headers };
  };

  const url = `${GROQ_BASE}/audio/transcriptions`;

  // Attempt sequence: first try sending original (or pre-transcoded if enabled),
  // on specific Groq 400 error attempt transcode-to-wav and retry once.
  let attemptedTranscode = false;
  let tempWavPath: string | null = null;
  let sendPath = filePath;

  // If TRANSCODE_ON_SERVER=true, pre-transcode before first attempt
  if (shouldTranscode) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.webm' || ext === '.ogg' || ext === '.opus') {
        tempWavPath = filePath + '.wav';
        if (!ffmpegPath) throw new Error('ffmpeg-static not available');
        execFileSync(ffmpegPath as string, ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', tempWavPath]);
        sendPath = tempWavPath;
        console.log('[transcribe] Pre-transcoded to WAV', { tempWavPath });
      }
    } catch (err) {
      console.warn('[transcribe] Pre-transcode failed, will try original file', err);
      sendPath = filePath;
      if (tempWavPath) { try { await fs.promises.unlink(tempWavPath); } catch(e) {} }
      tempWavPath = null;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { body, headers } = await buildMultipart(sendPath);
      console.log('[transcribe] Sending file to Groq', { filePath: sendPath, model: GROQ_MODEL, url, headers: Object.keys(headers) });
      const res = await fetch(url, { method: 'POST', headers: headers as any, body });

      if (!res.ok) {
        const text = await res.text();
        console.error('[transcribe] Groq failed', { status: res.status, body: text });

        // If Groq says 'could not process file' and we haven't tried transcode yet,
        // perform a transcode to WAV and retry once.
        const isCouldNotProcess = /could not process file/i.test(text) || /is it a valid media file/i.test(text);
        if (isCouldNotProcess && !attemptedTranscode) {
          console.log('[transcribe] Groq could not process file - trying server transcode and retry');
          attemptedTranscode = true;
          // transcode to wav
          try {
            if (!ffmpegPath) throw new Error('ffmpeg-static not available');
            tempWavPath = filePath + '.retry.wav';
            execFileSync(ffmpegPath as string, ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', tempWavPath]);
            sendPath = tempWavPath;
            console.log('[transcribe] Retrying with transcode', { tempWavPath });
            // continue loop to retry
            continue;
          } catch (err) {
            console.error('[transcribe] ffmpeg retry transcode failed', err);
            throw new Error(`Groq transcription failed and transcode retry failed: ${text}`);
          }
        }

        throw new Error(`Groq transcription failed: ${res.status} ${text}`);
      }

      // success
      let json: any = null;
      try { json = await res.json(); console.log('[transcribe] Groq response shape keys:', Object.keys(json || {})); } catch (e) { console.warn('[transcribe] Failed to parse Groq response as JSON', e); }
      const transcript =
        json?.text ||
        json?.results?.[0]?.text ||
        json?.transcript ||
        JSON.stringify(json);

      // Determine flags
      const transcoded = !!(tempWavPath && path.extname(sendPath).toLowerCase() === '.wav');
      const retried = attemptedTranscode;

      // cleanup temp files
      if (tempWavPath) { try { await fs.promises.unlink(tempWavPath); } catch (e) {} }

      return { transcript, retried, transcoded };
    } catch (err) {
      // if this was the retry attempt or non-transcode error, propagate
      if (attempt === 1 || attemptedTranscode) {
        // cleanup temp wav if exists
        if (tempWavPath) { try { await fs.promises.unlink(tempWavPath); } catch (e) {} }
        throw err;
      }
      // otherwise, loop to attempt transcode
    }
  }

  // should not reach here
  throw new Error('Transcription failed after retries');
}

export { sendMeetingSummaryEmail as sendSummaryByEmail } from '../utils/mailer';

export default transcribeBuffer;
