import { Router } from 'express';
import { BilibiliClient } from '../services/bilibili.js';

const router = Router();

router.post('/send', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const { uid, message } = req.body;
    if (!uid || !message) return res.status(400).json({ error: '参数不完整' });

    const client = new BilibiliClient(req.session.biliCookies || {});
    await client.sendPrivateMessage(uid, message);
    req.session.biliCookies = client.cookieJar;

    res.json({ ok: true, sentAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/check-reply/:uid', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const since = parseInt(req.query.since, 10) || 0;
    const uid = parseInt(req.params.uid, 10);
    const client = new BilibiliClient(req.session.biliCookies || {});
    const replied = await client.hasRecentReply(uid, since);
    req.session.biliCookies = client.cookieJar;

    res.json({ replied });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
