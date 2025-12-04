import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const app = express();
const port = Number(process.env.PORT || 3000);

// enable CORS for frontend requests
app.use(cors({ origin: true, credentials: true }));

// parse JSON bodies for finalize endpoint
app.use(express.json({ limit: '5mb' }));

// Mount audio routes
import audioRouter from './routes/audio';
app.use('/api/audio', audioRouter);

app.get('/health', (_req, res) => res.json({ ok: true, now: new Date().toISOString() }));

app.listen(port, () => {
  console.log(`[agorax_resume] listening on http://localhost:${port}`);
});

export default app;
