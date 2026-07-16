import { Router } from 'express';
import { runLottery, pickRedraw } from '../services/lottery.js';

const router = Router();

router.post('/draw', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const { pool, prizes, minDays } = req.body;
    if (!pool?.length || !prizes?.length) {
      return res.status(400).json({ error: '参数不完整' });
    }

    const filtered = pool.filter(f => f.followDays >= (minDays || 0));
    if (!filtered.length) {
      return res.status(400).json({ error: '没有符合条件的粉丝' });
    }

    const { session, drawQueue } = runLottery(filtered, prizes, minDays || 0);
    req.session.lotterySession = session;
    req.session.lastDrawQueue = drawQueue;

    res.json({
      drawQueue: drawQueue.map((d, i) => ({
        prize: d.prize,
        winner: d.winner,
        index: i + 1,
        total: drawQueue.length
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/redraw', (req, res) => {
  if (!req.session.loggedIn || !req.session.lotterySession) {
    return res.status(401).json({ error: '请先完成抽奖' });
  }

  try {
    const { excludedUids, prize } = req.body;
    const session = req.session.lotterySession;
    const pool = session.canonicalPool;
    const used = new Set(excludedUids || []);
    const available = pool.filter(f => !used.has(f.uid));

    if (!available.length) {
      return res.status(400).json({ error: '没有可重抽的粉丝' });
    }

    const result = pickRedraw(session, available, prize, req.body.oldWinnerUid);
    req.session.lotterySession = session;

    res.json({ winner: result.winner, audit: result.audit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
