import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import fansRoutes from './routes/fans.js';
import lotteryRoutes from './routes/lottery.js';
import notifyRoutes from './routes/notify.js';
import proxyRoutes from './routes/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'bilibili-lottery-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

app.use('/api/auth', authRoutes);
app.use('/api/fans', fansRoutes);
app.use('/api/lottery', lotteryRoutes);
app.use('/api/notify', notifyRoutes);
app.use('/api/proxy', proxyRoutes);

app.use(express.static(path.join(__dirname, '../public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('============================================');
  console.log('  Bilibili 粉丝抽奖工具  ·  作者 Leetaohua');
  console.log('============================================');
  console.log('');
  console.log(`  访问地址: ${url}`);
  console.log('');
  console.log('  服务在后台运行，停止请双击 停止.bat');
  console.log('============================================');
  console.log('');
});
