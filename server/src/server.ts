import 'dotenv/config';
import app from './app';
import { connectDB } from './db/connection';

const PORT = Number(process.env.PORT) || 3001;

(async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`[Server] User service running on http://localhost:${PORT}`);
  });
})();