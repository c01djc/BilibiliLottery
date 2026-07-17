import { Router } from 'express';
import { BilibiliClient, normalizeAvatarUrl, API_FAN_AUTO_LIMIT } from '../services/bilibili.js';

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

function buildFanPoolPayload(req, result, { preservePoolSource = false } = {}) {
  const bilibiliTotal = result.bilibiliTotal || req.session.user?.fans || result.fans.length;
  if (result.bilibiliTotal) {
    req.session.user.fans = result.bilibiliTotal;
  }
  req.session.fans = result.fans;

  let poolSource = result.poolSource || 'fans';
  if (preservePoolSource && req.session.poolSource) {
    poolSource = req.session.poolSource;
    if (poolSource === 'mixed') {
      req.session.fanBaseCount = (req.session.fanBaseCount || 0) + (result.added || 0);
    }
  } else {
    req.session.poolSource = poolSource;
    req.session.poolVideo = null;
  }

  const payload = {
    total: result.fetched,
    bilibiliTotal,
    missing: result.missing,
    complete: result.complete,
    apiMaxAutoFetch: API_FAN_AUTO_LIMIT,
    limited: result.limited,
    poolSource,
    added: result.added || 0,
    fans: result.fans
  };

  if (poolSource === 'mixed') {
    payload.commentCount = req.session.commentCount || 0;
    payload.fanBaseCount = req.session.fanBaseCount || result.fans.length;
    payload.fanPoolCount = req.session.fanBaseCount || result.fans.length;
    payload.videoTitle = req.session.poolVideo?.title || '';
    payload.videoBvid = req.session.poolVideo?.bvid || '';
    payload.contentKind = req.session.poolVideo?.contentKind || 'video';
  }

  return payload;
}

router.get('/sync-check', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const client = new BilibiliClient(req.session.biliCookies || {});
    const nav = await client.getNav();
    req.session.biliCookies = client.cookieJar;

    const currentTotal = nav.follower || nav.fans || 0;
    const cachedTotal = req.session.user?.fans || 0;
    const loadedCount = req.session.fans?.length || 0;
    const poolSource = req.session.poolSource || 'fans';
    const delta = currentTotal - Math.max(cachedTotal, loadedCount);

    res.json({
      currentTotal,
      cachedTotal,
      loadedCount,
      delta,
      hasNewFans: currentTotal > loadedCount,
      countChanged: currentTotal !== cachedTotal,
      needsSync: poolSource !== 'comments' && currentTotal > loadedCount,
      poolSource
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sync/stream', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  if (!req.session.fans?.length) {
    return res.status(400).json({ error: '请先获取粉丝数据' });
  }
  if (req.session.poolSource === 'comments') {
    return res.status(400).json({ error: '仅评论模式下请重新从评论获取' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const client = new BilibiliClient(req.session.biliCookies || {});
    await client.getNav();
    const mid = req.session.user.uid;
    const result = await client.syncNewFans(
      mid,
      req.session.fans,
      (progress) => send('progress', progress)
    );
    req.session.biliCookies = client.cookieJar;
    send('done', buildFanPoolPayload(req, result, { preservePoolSource: true }));
  } catch (e) {
    send('failed', { error: e.message });
  } finally {
    res.end();
  }
});

router.get('/stream', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const client = new BilibiliClient(req.session.biliCookies || {});
    await client.getNav();
    const mid = req.session.user.uid;
    const result = await client.getAllFans(mid, (progress) => send('progress', progress));

    req.session.biliCookies = client.cookieJar;
    send('done', buildFanPoolPayload(req, result));
  } catch (e) {
    send('failed', { error: e.message });
  } finally {
    res.end();
  }
});

router.get('/', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const client = new BilibiliClient(req.session.biliCookies || {});
    await client.getNav();
    const mid = req.session.user.uid;
    const result = await client.getAllFans(mid);
    req.session.biliCookies = client.cookieJar;

    res.json(buildFanPoolPayload(req, result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildCommentPoolPayload(req, result, commentOnly) {
  const existingFans = req.session.fans || [];
  const bilibiliTotal = req.session.user.fans || existingFans.length;
  const commentMeta = {
    title: result.videoTitle,
    bvid: result.videoBvid,
    contentKind: result.contentKind || 'video',
    count: result.fetched
  };

  let fans;
  let poolSource;
  const fanPoolComplete = existingFans.length >= bilibiliTotal;
  if (commentOnly) {
    fans = result.fans;
    poolSource = 'comments';
  } else {
    fans = mergeFans(existingFans, result.fans);
    poolSource = existingFans.length > 0 ? 'mixed' : 'comments';
  }

  req.session.fans = fans;
  req.session.poolSource = poolSource;
  req.session.poolVideo = commentMeta;
  req.session.commentCount = result.fetched;
  req.session.fanBaseCount = existingFans.length;

  const complete = commentOnly || fanPoolComplete || fans.length >= bilibiliTotal;

  return {
    total: fans.length,
    bilibiliTotal,
    missing: commentOnly ? 0 : Math.max(0, bilibiliTotal - existingFans.length),
    complete,
    apiMaxAutoFetch: commentOnly ? null : API_FAN_AUTO_LIMIT,
    limited: !complete,
    poolSource,
    commentOnly: !!commentOnly,
    commentCount: result.fetched,
    fanBaseCount: existingFans.length,
    fanPoolCount: existingFans.length,
    videoTitle: result.videoTitle,
    videoBvid: result.videoBvid,
    contentKind: result.contentKind || 'video',
    fans
  };
}

router.get('/from-video/stream', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  const { videoId, keyword = '', commentOnly } = req.query || {};
  if (!videoId) {
    return res.status(400).json({ error: '请输入视频 BV 号、视频链接或动态 opus 链接' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const client = new BilibiliClient(req.session.biliCookies || {});
    await client.getNav();
    const result = await client.fetchCommentParticipants(String(videoId), {
      keyword: String(keyword || ''),
      onProgress: (progress) => send('progress', progress)
    });
    req.session.biliCookies = client.cookieJar;

    const onlyComments = commentOnly === '1' || commentOnly === 'true';
    if (!onlyComments && req.session.fans?.length) {
      send('progress', {
        phase: 'merge',
        fetched: result.fetched,
        total: result.fetched,
        message: `正在合并到粉丝池（评论 ${result.fetched} 人）...`
      });
    }

    send('done', buildCommentPoolPayload(req, result, onlyComments));
  } catch (e) {
    send('failed', { error: e.message });
  } finally {
    res.end();
  }
});

router.post('/from-video', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const { videoId, keyword, commentOnly } = req.body || {};
    if (!videoId) return res.status(400).json({ error: '请输入视频 BV 号、视频链接或动态 opus 链接' });

    const client = new BilibiliClient(req.session.biliCookies || {});
    await client.getNav();
    const result = await client.fetchCommentParticipants(videoId, { keyword: keyword || '' });
    req.session.biliCookies = client.cookieJar;

    res.json(buildCommentPoolPayload(req, result, !!commentOnly));
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

    const existing = req.session.fans || [];
    const existingUids = new Set(existing.map(f => f.uid));
    const added = imported.filter(f => !existingUids.has(f.uid));

    const merged = mergeFans(existing, imported);
    req.session.fans = merged;
    const bilibiliTotal = req.session.user.fans || merged.length;
    const complete = merged.length >= bilibiliTotal;

    res.json({
      total: merged.length,
      bilibiliTotal,
      missing: Math.max(0, bilibiliTotal - merged.length),
      complete,
      apiMaxAutoFetch: API_FAN_AUTO_LIMIT,
      limited: !complete,
      poolSource: req.session.poolSource || 'fans',
      imported: imported.length,
      added: added.length,
      duplicates: imported.length - added.length,
      fans: merged
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
