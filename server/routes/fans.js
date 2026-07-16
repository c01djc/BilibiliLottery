import { Router } from 'express';
import { BilibiliClient, normalizeAvatarUrl } from '../services/bilibili.js';

const router = Router();

function normalizeImportedFan(raw) {
  const uid = Number(raw.uid ?? raw.mid);
  const name = String(raw.name ?? raw.uname ?? '').trim();
  if (!uid || !name) return null;

  const face = raw.avatar ?? raw.face ?? '';
  const avatar = face
    ? (face.startsWith('/api/proxy/avatar') ? face : normalizeAvatarUrl(face))
    : '';

  return {
    uid,
    name,
    avatar,
    followDays: Math.max(0, Number(raw.followDays ?? raw.follow_days ?? 0) || 0),
    vip: false
  };
}

function mergeFans(existing, incoming) {
  const byUid = new Map(existing.map(f => [f.uid, f]));
  for (const fan of incoming) {
    if (!byUid.has(fan.uid)) byUid.set(fan.uid, fan);
  }
  return [...byUid.values()].sort((a, b) => b.followDays - a.followDays);
}

router.get('/', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const client = new BilibiliClient(req.session.biliCookies || {});
    const mid = req.session.user.uid;
    const result = await client.getAllFans(mid);
    req.session.biliCookies = client.cookieJar;
    req.session.fans = result.fans;
    if (result.bilibiliTotal) {
      req.session.user.fans = result.bilibiliTotal;
    }

    res.json({
      total: result.fetched,
      bilibiliTotal: result.bilibiliTotal,
      limited: result.limited,
      fans: result.fans
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const list = Array.isArray(req.body?.fans) ? req.body.fans : [];
    const imported = list.map(normalizeImportedFan).filter(Boolean);
    if (imported.length === 0) {
      return res.status(400).json({ error: '没有有效的粉丝数据' });
    }

    const merged = mergeFans(req.session.fans || [], imported);
    req.session.fans = merged;
    const bilibiliTotal = req.session.user.fans || merged.length;

    res.json({
      total: merged.length,
      bilibiliTotal,
      limited: bilibiliTotal > merged.length,
      imported: imported.length,
      fans: merged
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
