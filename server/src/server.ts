import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import { connectDB } from './db/connection';
import { initSocket } from './socket';

const PORT = Number(process.env.PORT) || 3001;

(async () => {
  try {
    await connectDB();
  } catch (err: any) {
    console.warn(`[Server] PostgreSQL unavailable - DB features disabled. (${err.message})`);
  }

  const httpServer = createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`[Server] Running on http://localhost:${PORT} (HTTP + WebSocket)`);
  });
})();
