import 'dotenv/config';
import app from './app';
import { connectDB } from './db/connection';

const PORT = Number(process.env.PORT) || 3001;

(async () => {
  try {
    await connectDB();
  } catch (err: any) {
    console.warn(`[Server] PostgreSQL unavailable - DB features disabled. (${err.message})`);
  }
  app.listen(PORT, () => {
    console.log(`[Server] User service running on http://localhost:${PORT}`);
  });
})();
