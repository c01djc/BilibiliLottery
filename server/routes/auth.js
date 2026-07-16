import { Router } from 'express';
import { BilibiliClient, normalizeAvatarUrl } from '../services/bilibili.js';

const router = Router();

function getClient(req) {
  return new BilibiliClient(req.session.biliCookies || {});
}

router.get('/qrcode', async (req, res) => {
  try {
    const client = new BilibiliClient();
    const { url, qrcode_key } = await client.generateQR();
    req.session.qrcodeKey = qrcode_key;
    req.session.biliCookies = client.cookieJar;
    res.json({ url, qrcode_key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/poll', async (req, res) => {
  try {
    const key = req.query.qrcode_key || req.session.qrcodeKey;
    if (!key) return res.status(400).json({ error: '无二维码会话' });

    const client = getClient(req);
    const data = await client.pollQR(key);
    req.session.biliCookies = client.cookieJar;

    // 0=成功 86101=未扫码 86090=已扫码未确认 86038=过期
    if (data.code === 0) {
      const nav = await client.getNav();
      req.session.user = {
        uid: nav.mid,
        name: nav.uname,
        avatar: normalizeAvatarUrl(nav.face),
        fans: nav.follower || nav.fans || 0
      };
      req.session.loggedIn = true;
    }

    res.json({
      status: data.code,
      message: data.message,
      user: req.session.user || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', async (req, res) => {
  if (!req.session.loggedIn) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

export default router;
