import { Router } from 'express';

const router = Router();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

router.get('/avatar', async (req, res) => {
  const raw = req.query.u;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).end();
  }

  let url;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  } catch {
    return res.status(400).end();
  }

  if (!['http:', 'https:'].includes(url.protocol) || !/\.hdslb\.com$/i.test(url.hostname)) {
    return res.status(400).end();
  }

  try {
    const imgRes = await fetch(url.href, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com'
      }
    });

    if (!imgRes.ok) {
      return res.status(imgRes.status).end();
    }

    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await imgRes.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

export default router;
