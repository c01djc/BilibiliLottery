import crypto from 'crypto';

const UINT32_MAX = 0xffffffff;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function canonicalizePool(pool) {
  return [...pool].sort((a, b) => a.uid - b.uid);
}

function deriveUint32(seed, drawIndex, nonce) {
  const hash = sha256(`${seed}|draw|${drawIndex}|${nonce}`);
  return parseInt(hash.slice(0, 8), 16) >>> 0;
}

function randomInt(seed, drawIndex, max, nonce = 0) {
  if (max <= 0) throw new Error('invalid max');
  if (max === 1) return 0;
  const range = UINT32_MAX + 1;
  const limit = Math.floor(range / max) * max;
  let attempt = 0;
  while (attempt < 128) {
    const val = deriveUint32(seed, drawIndex, nonce + attempt);
    if (val < limit) return val % max;
    attempt++;
  }
  throw new Error('无法生成无偏随机数');
}

function pickWinner(session, available) {
  const drawIndex = session.drawCounter;
  const idx = randomInt(session.seed, drawIndex, available.length);
  const prob = (100 / available.length).toFixed(4) + '%';
  return {
    winner: available[idx],
    audit: {
      drawIndex,
      type: 'draw',
      mode: 'uniform',
      randomValue: idx,
      selectedIndex: idx,
      candidateCount: available.length,
      probability: prob,
      candidateUids: available.map(f => f.uid)
    }
  };
}

export function createSession(pool, prizeList, minDays) {
  const seed = generateSeed();
  const canonicalPool = canonicalizePool(pool);
  const poolData = canonicalPool.map(f => ({ uid: f.uid, followDays: f.followDays }));
  const poolFingerprint = sha256(JSON.stringify(poolData));
  const timestamp = new Date().toISOString();

  const publicParams = {
    version: '1.0',
    algorithm: 'uniform_csrng_v1',
    poolFingerprint,
    poolSize: canonicalPool.length,
    minDays,
    prizes: prizeList.map(p => ({ name: p.name, count: p.count, level: p.level })),
    timestamp,
    rule: 'equal probability for all eligible fans'
  };

  const commitHash = sha256(seed + '|' + JSON.stringify(publicParams));

  return {
    seed,
    commitHash,
    publicParams,
    canonicalPool,
    poolFingerprint,
    timestamp,
    minDays,
    auditLog: [],
    drawCounter: 0
  };
}

export function buildDrawQueue(session, prizeList) {
  const queue = [];
  const usedUids = new Set();
  const pool = session.canonicalPool;

  for (const prize of prizeList) {
    for (let i = 0; i < prize.count; i++) {
      const available = pool.filter(f => !usedUids.has(f.uid));
      if (available.length === 0) break;

      const result = pickWinner(session, available);
      session.drawCounter++;
      session.auditLog.push({
        ...result.audit,
        prize: prize.name,
        prizeLevel: prize.level,
        winnerUid: result.winner.uid,
        winnerName: result.winner.name,
        timestamp: new Date().toISOString()
      });

      usedUids.add(result.winner.uid);
      queue.push({ prize, winner: result.winner, audit: result.audit });
    }
  }
  return queue;
}

export function pickRedraw(session, available, prize, oldWinnerUid) {
  const result = pickWinner(session, available);
  session.drawCounter++;
  session.auditLog.push({
    ...result.audit,
    type: 'redraw',
    prize: prize.name,
    prizeLevel: prize.level,
    winnerUid: result.winner.uid,
    winnerName: result.winner.name,
    replacedUid: oldWinnerUid,
    timestamp: new Date().toISOString()
  });
  return result;
}

export function runLottery(pool, prizeList, minDays) {
  const session = createSession(pool, prizeList, minDays);
  const drawQueue = buildDrawQueue(session, prizeList);
  return { session, drawQueue };
}
