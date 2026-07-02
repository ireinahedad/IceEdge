import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import { connectDB } from './db/connection';
import { initSocket } from './socket';
import { startSettlementJob } from './services/settlement.service';

const PORT = Number(process.env.PORT) || 3001;

(async () => {
  try {
    await connectDB();
    // Auto-settle pending bets against real NHL results every 15 min
    startSettlementJob();
  } catch (err: any) {
    console.warn(`[Server] PostgreSQL unavailable - DB features disabled. (${err.message})`);
  }

  const httpServer = createServer(app);
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`[Server] Running on http://localhost:${PORT} (HTTP + WebSocket)`);
  });
})();
