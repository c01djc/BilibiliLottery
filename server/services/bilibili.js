import crypto from 'crypto';

const BILI_PASSPORT = 'https://passport.bilibili.com';
const BILI_API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseCookies(setCookieHeaders) {
  const jar = {};
  for (const header of setCookieHeaders) {
    const part = header.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

function mergeCookies(existing, incoming) {
  const jar = { ...existing };
  for (const [k, v] of Object.entries(incoming)) jar[k] = v;
  return jar;
}

function cookieJarToString(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cryptoRandomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function normalizeAvatarUrl(face) {
  if (!face) return '';
  const url = face.startsWith('http') ? face : face.startsWith('//') ? `https:${face}` : '';
  if (!url) return '';
  return `/api/proxy/avatar?u=${encodeURIComponent(url)}`;
}

function mapFanRecord(f) {
  const followDays = f.mtime
    ? Math.max(0, Math.floor((Date.now() - f.mtime * 1000) / 86400000))
    : 0;
  return {
    uid: f.mid,
    name: f.uname,
    avatar: normalizeAvatarUrl(f.face),
    followDays,
    vip: false
  };
}

export class BilibiliClient {
  constructor(cookieJar = {}) {
    this.cookieJar = cookieJar;
  }

  get cookie() {
    return cookieJarToString(this.cookieJar);
  }

  absorbResponse(res) {
    const raw = res.headers.getSetCookie?.() || [];
    if (raw.length) {
      this.cookieJar = mergeCookies(this.cookieJar, parseCookies(raw));
    }
  }

  async request(url, options = {}) {
    let res;
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com',
          Cookie: this.cookie,
          ...(options.headers || {})
        }
      });
    } catch (e) {
      const hint = e.cause?.code === 'ENOTFOUND'
        ? '无法连接 B站服务器，请检查网络连接'
        : '网络请求失败';
      throw new Error(`${hint}: ${e.cause?.message || e.message}`);
    }
    this.absorbResponse(res);
    return res.json();
  }

  async generateQR() {
    const data = await this.request(
      `${BILI_PASSPORT}/x/passport-login/web/qrcode/generate?source=main-mini`
    );
    if (data.code !== 0) throw new Error(data.message || '生成二维码失败');
    return data.data;
  }

  async pollQR(qrcodeKey) {
    const data = await this.request(
      `${BILI_PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}&source=main-mini`
    );
    if (data.code !== 0) throw new Error(data.message || '轮询失败');
    return data.data;
  }

  async getNav() {
    const data = await this.request(`${BILI_API}/x/web-interface/nav`);
    if (data.code !== 0) throw new Error(data.message || '获取用户信息失败');
    return data.data;
  }

  async fetchFanPages(mid, order = 'desc') {
    const byUid = new Map();
    let bilibiliTotal = 0;
    const pageSize = 50;
    const maxPages = 20;

    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request(
        `${BILI_API}/x/relation/fans?vmid=${mid}&pn=${page}&ps=${pageSize}&order=${order}`
      );
      if (data.code !== 0) throw new Error(data.message || '获取粉丝列表失败');

      const list = data.data?.list || [];
      bilibiliTotal = data.data?.total || bilibiliTotal;

      for (const f of list) {
        byUid.set(f.mid, mapFanRecord(f));
      }

      if (list.length === 0) break;
      await sleep(250);
    }

    return { byUid, bilibiliTotal };
  }

  async getAllFans(mid) {
    const desc = await this.fetchFanPages(mid, 'desc');
    const byUid = new Map(desc.byUid);
    let bilibiliTotal = desc.bilibiliTotal;

    if (byUid.size < bilibiliTotal) {
      const asc = await this.fetchFanPages(mid, 'asc');
      bilibiliTotal = Math.max(bilibiliTotal, asc.bilibiliTotal);
      for (const [uid, fan] of asc.byUid) {
        if (!byUid.has(uid)) byUid.set(uid, fan);
      }
    }

    const fans = [...byUid.values()].sort((a, b) => b.followDays - a.followDays);

    return {
      fans,
      bilibiliTotal,
      fetched: fans.length,
      limited: bilibiliTotal > 0 && fans.length < bilibiliTotal
    };
  }

  async sendPrivateMessage(receiverUid, content) {
    const nav = await this.getNav();
    const senderUid = nav.mid;
    const csrf = this.cookieJar.bili_jct || this.cookieJar.csrf;

    if (!csrf) throw new Error('缺少 CSRF token，请重新登录');

    const body = new URLSearchParams({
      msg_type: '1',
      sender_uid: String(senderUid),
      receiver_id: String(receiverUid),
      msg: JSON.stringify({ content }),
      dev_id: cryptoRandomHex(8),
      timestamp: String(Math.floor(Date.now() / 1000)),
      csrf
    });

    const res = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: 'https://message.bilibili.com',
        Cookie: this.cookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    this.absorbResponse(res);
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.message || '发送私信失败');
    return data;
  }

  async hasRecentReply(talkerId, sinceTs) {
    const csrf = this.cookieJar.bili_jct || '';
    const data = await this.request(
      `https://api.vc.bilibili.com/web_im/v1/web_im/rsp_fetch_msg?sender_device_id=1&talker_id=${talkerId}&session_type=1&size=20&csrf=${csrf}`
    );
    if (data.code !== 0) return false;

    const messages = data.data?.messages || [];
    return messages.some(m => {
      const isFromFan = m.sender_uid === talkerId;
      const ts = (m.timestamp || 0) * 1000;
      return isFromFan && ts >= sinceTs;
    });
  }
}
