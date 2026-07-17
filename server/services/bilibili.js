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

export const API_FAN_AUTO_LIMIT = 2000;
const FAN_PAGE_SIZE = 50;
const FAN_PAGE_MAX = 20;
const FAN_WEB_PAGE_SIZE = 20;
const FAN_WEB_MAX_PAGES = 200;

const OPUS_DETAIL_FEATURES = 'onlyfansVote,onlyfansAssetsV2,decorationCard,htmlNewStyle,ugcDelete,editable,opusPrivateVisible,tribeeEdit,avatarAutoTheme,avatarTypeOpus';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52
];

function formatBiliApiError(code, message) {
  const codeNum = Number(code);
  const msg = String(message || '').trim();
  if (codeNum === -352 || msg === '-352') {
    return 'B站接口触发风控（-352），请稍后重试；若仍失败请退出后重新扫码登录';
  }
  if (codeNum === -101) return '登录已过期，请重新扫码登录';
  if (codeNum === -403) return '无权访问该内容，请确认链接正确且为公开状态';
  if (codeNum === 412) return 'B站请求被风控拦截，请稍后再试';
  if (msg && msg !== '0' && !/^-?\d+$/.test(msg)) return msg;
  if (codeNum) return `B站接口错误（${codeNum}），请稍后重试`;
  return msg || 'B站接口请求失败';
}

function genBuvid3() {
  return `${crypto.randomUUID().replace(/-/g, '')}${Math.floor(Date.now() / 1000)}infoc`;
}

function genBuvid4() {
  return `${crypto.randomUUID()}-${Math.floor(Date.now() / 1000)}-0-0-${cryptoRandomHex(16)}`;
}

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map(i => orig[i]).join('').slice(0, 32);
}

function encWbiParams(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const signed = { ...params, wts: Math.round(Date.now() / 1000) };
  const sorted = Object.keys(signed).sort();
  const query = sorted.map((key) => {
    const val = String(signed[key]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
  }).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return { ...signed, w_rid };
}

function extractWbiKeys(wbiImg) {
  if (!wbiImg?.img_url || !wbiImg?.sub_url) return null;
  const imgKey = wbiImg.img_url.split('/').pop().split('.')[0];
  const subKey = wbiImg.sub_url.split('/').pop().split('.')[0];
  return { imgKey, subKey };
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
    this.wbiKeys = null;
    this.wbiKeysAt = 0;
    this.ensureDeviceCookies();
  }

  get cookie() {
    return cookieJarToString(this.cookieJar);
  }

  ensureDeviceCookies() {
    if (!this.cookieJar.buvid3) this.cookieJar.buvid3 = genBuvid3();
    if (!this.cookieJar.buvid4) this.cookieJar.buvid4 = genBuvid4();
  }

  cacheWbiKeys(wbiImg) {
    const keys = extractWbiKeys(wbiImg);
    if (keys) {
      this.wbiKeys = keys;
      this.wbiKeysAt = Date.now();
    }
  }

  async refreshWbiKeys(force = false) {
    if (!force && this.wbiKeys && Date.now() - this.wbiKeysAt < 3600000) {
      return this.wbiKeys;
    }
    const data = await this.request(`${BILI_API}/x/web-interface/nav`, { soft: true });
    if (data?.code === 0) {
      this.cacheWbiKeys(data.data?.wbi_img);
    }
    return this.wbiKeys;
  }

  failIfApiError(data, fallback) {
    if (!data || data.code !== 0) {
      throw new Error(formatBiliApiError(data?.code, data?.message || fallback));
    }
  }

  async apiGet(path, params, options = {}) {
    this.ensureDeviceCookies();
    const buildUrl = (queryParams) => `${path}?${new URLSearchParams(
      Object.entries(queryParams).map(([k, v]) => [k, String(v)])
    )}`;

    let data = await this.request(buildUrl(params), options);
    if (!options.soft && data?.code === -352) {
      await sleep(1500);
      const wbi = await this.refreshWbiKeys(true);
      if (wbi?.imgKey && wbi?.subKey) {
        const signed = encWbiParams(params, wbi.imgKey, wbi.subKey);
        data = await this.request(buildUrl(signed), options);
      }
    }
    return data;
  }

  absorbResponse(res) {
    const raw = res.headers.getSetCookie?.() || [];
    if (raw.length) {
      this.cookieJar = mergeCookies(this.cookieJar, parseCookies(raw));
    }
  }

  async request(url, options = {}) {
    const { soft = false, ...fetchOptions } = options;
    let res;
    try {
      res = await fetch(url, {
        ...fetchOptions,
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com',
          Origin: 'https://www.bilibili.com',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Cookie: this.cookie,
          ...(fetchOptions.headers || {})
        }
      });
    } catch (e) {
      if (soft) return null;
      const hint = e.cause?.code === 'ENOTFOUND'
        ? '无法连接 B站服务器，请检查网络连接'
        : '网络请求失败';
      throw new Error(`${hint}: ${e.cause?.message || e.message}`);
    }
    this.absorbResponse(res);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (soft) return null;
      throw new Error('B站接口返回异常，请稍后重试');
    }
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
    this.failIfApiError(data, '获取用户信息失败');
    this.cacheWbiKeys(data.data?.wbi_img);
    return data.data;
  }

  async fetchFanPages(mid, { order = 'desc', endpoint = 'fans', orderType = '', required = false } = {}) {
    const byUid = new Map();
    let bilibiliTotal = 0;
    let reVersion = '0';
    const referer = `https://space.bilibili.com/${mid}/fans`;

    for (let page = 1; page <= FAN_PAGE_MAX; page++) {
      let url;
      if (endpoint === 'fans') {
        const params = new URLSearchParams({
          vmid: String(mid),
          pn: String(page),
          ps: String(FAN_PAGE_SIZE),
          order,
          gaia_source: 'main_web',
          web_location: '333.999'
        });
        if (orderType) params.set('order_type', orderType);
        url = `${BILI_API}/x/relation/fans?${params}`;
      } else {
        const params = new URLSearchParams({
          re_version: reVersion,
          vmid: String(mid),
          pn: String(page),
          ps: String(FAN_PAGE_SIZE)
        });
        url = `${BILI_API}/x/relation/followers?${params}`;
      }

      const soft = !(required && page === 1);
      const data = await this.request(url, { soft, headers: { Referer: referer } });
      if (!data) break;

      if (data.code !== 0) {
        if (required && page === 1) {
          throw new Error(formatBiliApiError(data.code, data.message || '获取粉丝列表失败'));
        }
        break;
      }

      const list = data.data?.list || [];
      bilibiliTotal = data.data?.total || bilibiliTotal;

      for (const f of list) {
        byUid.set(f.mid, mapFanRecord(f));
      }

      if (endpoint === 'followers' && data.data?.re_version != null) {
        reVersion = String(data.data.re_version);
      }

      if (list.length < FAN_PAGE_SIZE) break;
      await sleep(300);
    }

    return { byUid, bilibiliTotal };
  }

  mergeFanBatches(byUid, batches) {
    let bilibiliTotal = 0;
    for (const batch of batches) {
      bilibiliTotal = Math.max(bilibiliTotal, batch.bilibiliTotal || 0);
      for (const [uid, fan] of batch.byUid) {
        if (!byUid.has(uid)) byUid.set(uid, fan);
      }
    }
    return bilibiliTotal;
  }

  /** 与 B 站网页粉丝列表同款：ps=20 + pn 翻页（可超过旧版 20 页×50 条限制） */
  async fetchFansWebPaginated(mid, onProgress) {
    const byUid = new Map();
    let bilibiliTotal = 0;
    let maxPages = FAN_WEB_MAX_PAGES;
    let lastOffset = '';
    const referer = `https://space.bilibili.com/${mid}/fans`;

    const report = (extra = {}) => {
      if (!onProgress) return;
      onProgress({
        phase: 'fetch',
        fetched: byUid.size,
        total: bilibiliTotal,
        page: extra.page ?? 0,
        maxPages,
        message: extra.message || (bilibiliTotal > 0
          ? `已获取 ${byUid.size} / ${bilibiliTotal} 位粉丝`
          : `已获取 ${byUid.size} 位粉丝`)
      });
    };

    report({ message: '正在连接 B 站粉丝接口...' });

    for (let pn = 1; pn <= maxPages; pn++) {
      const params = {
        vmid: String(mid),
        pn: String(pn),
        ps: String(FAN_WEB_PAGE_SIZE),
        gaia_source: 'main_web',
        web_location: '333.1387'
      };

      const data = await this.apiGet(
        `${BILI_API}/x/relation/fans`,
        params,
        { soft: pn > 1, headers: { Referer: referer } }
      );
      if (!data) break;
      if (data.code !== 0) {
        if (pn === 1) throw new Error(formatBiliApiError(data.code, data.message || '获取粉丝列表失败'));
        break;
      }

      bilibiliTotal = data.data?.total || bilibiliTotal;
      if (pn === 1 && bilibiliTotal > 0) {
        maxPages = Math.min(FAN_WEB_MAX_PAGES, Math.ceil(bilibiliTotal / FAN_WEB_PAGE_SIZE) + 2);
      }

      const list = data.data?.list || [];
      for (const f of list) {
        byUid.set(f.mid, mapFanRecord(f));
      }

      if (data.data?.offset) lastOffset = data.data.offset;

      if (list.length === 0) break;
      if (bilibiliTotal > 0 && byUid.size >= bilibiliTotal) break;

      report({
        page: pn,
        message: bilibiliTotal > 0
          ? `第 ${pn}/${maxPages} 页 · 已获取 ${byUid.size} / ${bilibiliTotal}`
          : `第 ${pn}/${maxPages} 页 · 已获取 ${byUid.size} 人`
      });
      await sleep(260);
    }

    if (bilibiliTotal > 0 && byUid.size < bilibiliTotal && lastOffset && lastOffset !== 'rcmd') {
      report({ message: `正在补拉剩余粉丝（${byUid.size}/${bilibiliTotal}）...` });
      let offset = lastOffset;
      for (let guard = 0; guard < 100; guard++) {
        const params = {
          vmid: String(mid),
          ps: String(FAN_WEB_PAGE_SIZE),
          gaia_source: 'main_web',
          web_location: '333.1387',
          offset
        };

        const data = await this.apiGet(
          `${BILI_API}/x/relation/fans`,
          params,
          { soft: true, headers: { Referer: referer } }
        );
        if (!data || data.code !== 0) break;

        const list = data.data?.list || [];
        for (const f of list) {
          byUid.set(f.mid, mapFanRecord(f));
        }

        if (list.length === 0 || byUid.size >= bilibiliTotal) break;

        report({
          message: `补拉中 · 已获取 ${byUid.size} / ${bilibiliTotal}`
        });

        const nextOffset = data.data?.offset;
        if (!nextOffset || nextOffset === 'rcmd' || nextOffset === offset) break;
        offset = nextOffset;
        await sleep(260);
      }
    }

    return { byUid, bilibiliTotal };
  }

  async getAllFans(mid, onProgress) {
    const web = await this.fetchFansWebPaginated(mid, onProgress);
    const byUid = new Map(web.byUid);
    let bilibiliTotal = web.bilibiliTotal;

    if (bilibiliTotal > 0 && byUid.size < bilibiliTotal) {
      const strategies = [
        { order: 'desc', endpoint: 'fans', label: '最新粉丝' },
        { order: 'asc', endpoint: 'fans', label: '最早粉丝' },
        { endpoint: 'followers', label: '关注顺序' }
      ];

      for (let i = 0; i < strategies.length; i++) {
        if (byUid.size >= bilibiliTotal) break;
        if (i > 0) await sleep(600);

        if (onProgress) {
          onProgress({
            phase: 'merge',
            fetched: byUid.size,
            total: bilibiliTotal,
            message: `正在通过「${strategies[i].label}」补全（${byUid.size}/${bilibiliTotal}）...`
          });
        }

        try {
          const batch = await this.fetchFanPages(mid, strategies[i]);
          bilibiliTotal = Math.max(bilibiliTotal, batch.bilibiliTotal);
          for (const [uid, fan] of batch.byUid) {
            if (!byUid.has(uid)) byUid.set(uid, fan);
          }
        } catch {
          // 网页分页为主，旧接口仅作补全
        }
      }
    }

    if (byUid.size === 0) {
      throw new Error('获取粉丝列表失败，请稍后重试或重新登录');
    }

    const fans = [...byUid.values()].sort((a, b) => b.followDays - a.followDays);
    const complete = bilibiliTotal > 0 && fans.length >= bilibiliTotal;

    if (onProgress) {
      onProgress({
        phase: 'done',
        fetched: fans.length,
        total: bilibiliTotal,
        message: complete ? `已获取全部 ${fans.length} 位粉丝` : `已获取 ${fans.length} / ${bilibiliTotal} 位粉丝`
      });
    }

    return {
      fans,
      bilibiliTotal,
      fetched: fans.length,
      missing: Math.max(0, bilibiliTotal - fans.length),
      complete,
      apiMaxAutoFetch: API_FAN_AUTO_LIMIT,
      limited: !complete,
      poolSource: 'fans'
    };
  }

  /** 增量同步：从最新页起翻页，合并新增粉丝，遇到整页无新增即停止 */
  async syncNewFans(mid, existingFans, onProgress) {
    const byUid = new Map((existingFans || []).map(f => [Number(f.uid), f]));
    const startCount = byUid.size;
    let bilibiliTotal = 0;
    const referer = `https://space.bilibili.com/${mid}/fans`;

    const report = (message, extra = {}) => {
      if (!onProgress) return;
      onProgress({
        phase: 'fetch',
        fetched: byUid.size,
        total: bilibiliTotal,
        added: byUid.size - startCount,
        message,
        ...extra
      });
    };

    report('正在检查粉丝变化...');

    for (let pn = 1; pn <= FAN_WEB_MAX_PAGES; pn++) {
      const data = await this.apiGet(
        `${BILI_API}/x/relation/fans`,
        {
          vmid: String(mid),
          pn: String(pn),
          ps: String(FAN_WEB_PAGE_SIZE),
          gaia_source: 'main_web',
          web_location: '333.1387'
        },
        { soft: pn > 1, headers: { Referer: referer } }
      );
      if (!data) break;
      if (data.code !== 0) {
        if (pn === 1) this.failIfApiError(data, '同步新粉丝失败');
        break;
      }

      bilibiliTotal = data.data?.total || bilibiliTotal;
      const list = data.data?.list || [];
      let addedOnPage = 0;
      for (const f of list) {
        if (!byUid.has(f.mid)) {
          byUid.set(f.mid, mapFanRecord(f));
          addedOnPage++;
        }
      }

      const added = byUid.size - startCount;
      report(
        bilibiliTotal > 0
          ? `第 ${pn} 页 · 新增 ${added} 人（B站共 ${bilibiliTotal}）`
          : `第 ${pn} 页 · 新增 ${added} 人`,
        { page: pn, added }
      );

      if (addedOnPage === 0) break;
      if (bilibiliTotal > 0 && byUid.size >= bilibiliTotal) break;
      if (list.length === 0) break;
      await sleep(260);
    }

    const fans = [...byUid.values()].sort((a, b) => b.followDays - a.followDays);
    const added = fans.length - startCount;
    const complete = bilibiliTotal > 0 && fans.length >= bilibiliTotal;

    if (onProgress) {
      onProgress({
        phase: 'done',
        fetched: fans.length,
        total: bilibiliTotal,
        added,
        message: added > 0
          ? `同步完成：新增 ${added} 位粉丝，当前共 ${fans.length} 人`
          : `暂无新粉丝，当前共 ${fans.length} 人`
      });
    }

    return {
      fans,
      bilibiliTotal,
      fetched: fans.length,
      added,
      missing: Math.max(0, bilibiliTotal - fans.length),
      complete,
      apiMaxAutoFetch: API_FAN_AUTO_LIMIT,
      limited: !complete,
      poolSource: 'fans'
    };
  }

  async resolveVideoTarget(input) {
    const trimmed = String(input || '').trim();
    const bvMatch = trimmed.match(/BV[\w]+/i);
    const bvid = bvMatch ? bvMatch[0] : (/^BV[\w]+$/i.test(trimmed) ? trimmed : null);
    const avMatch = trimmed.match(/av(\d+)/i);
    if (avMatch) {
      const aid = Number(avMatch[1]);
      return {
        type: 1,
        oid: aid,
        title: `视频 av${aid}`,
        referer: `https://www.bilibili.com/video/av${aid}`,
        contentKind: 'video',
        contentId: `av${aid}`
      };
    }
    if (/^\d+$/.test(trimmed)) {
      const aid = Number(trimmed);
      return {
        type: 1,
        oid: aid,
        title: `视频 av${aid}`,
        referer: `https://www.bilibili.com/video/av${aid}`,
        contentKind: 'video',
        contentId: `av${aid}`
      };
    }

    if (!bvid) throw new Error('无法识别视频，请输入 BV 号或视频链接');

    const data = await this.apiGet(`${BILI_API}/x/web-interface/view`, { bvid });
    this.failIfApiError(data, '视频不存在');
    return {
      type: 1,
      oid: data.data.aid,
      title: data.data.title,
      referer: `https://www.bilibili.com/video/${data.data.bvid}`,
      contentKind: 'video',
      contentId: data.data.bvid
    };
  }

  async resolveOpusTarget(opusId) {
    const id = String(opusId || '').trim();
    if (!/^\d{15,}$/.test(id)) {
      throw new Error('动态 ID 不完整，请从浏览器地址栏复制完整的 opus 链接（数字通常有 15 位以上）');
    }

    const referer = `https://www.bilibili.com/opus/${id}`;
    let commentType = 17;
    let oid = Number(id);
    let title = `动态 ${id}`;

    const data = await this.apiGet(
      `${BILI_API}/x/polymer/web-dynamic/v1/opus/detail`,
      { id, timezone_offset: '-480', features: OPUS_DETAIL_FEATURES },
      { headers: { Referer: referer } }
    );
    this.failIfApiError(data, '动态不存在或无权查看');

    const item = data.data?.item;
    const basic = item?.basic;
    if (!basic?.comment_id_str && !basic?.rid_str) {
      throw new Error('无法解析该动态，请确认链接完整且动态为公开状态');
    }

    commentType = Number(basic.comment_type) || 17;
    const oidStr = basic.comment_id_str || basic.rid_str;
    if (oidStr) oid = Number(oidStr);

    if (commentType === 11) {
      const dyn = item.modules?.module_dynamic;
      const rid = dyn?.major?.opus?.summary?.rid
        || dyn?.major?.draw?.id
        || dyn?.major?.opus?.rid
        || basic.rid_str;
      if (rid) oid = Number(rid);
    }

    if (basic.title) title = basic.title;

    const author = item?.modules?.module_author;
    if (author?.name && title.startsWith('动态')) {
      title = `${author.name} 的动态`;
    }

    return {
      type: commentType,
      oid,
      title,
      referer,
      contentKind: 'opus',
      contentId: id
    };
  }

  async resolveContentTarget(input) {
    const trimmed = String(input || '').trim();
    const opusMatch = trimmed.match(/opus\/(\d+)/i)
      || trimmed.match(/t\.bilibili\.com\/(\d+)/i)
      || trimmed.match(/[?&]dynamic_id=(\d+)/i);
    if (opusMatch) return this.resolveOpusTarget(opusMatch[1]);
    return this.resolveVideoTarget(trimmed);
  }

  addReplyParticipant(byUid, reply, keyword) {
    const member = reply.member || {};
    const uid = member.mid;
    const name = member.uname;
    if (!uid || !name) return;

    const msg = reply.content?.message || '';
    if (keyword && !msg.includes(keyword)) return;

    if (!byUid.has(uid)) {
      byUid.set(uid, {
        uid,
        name,
        avatar: normalizeAvatarUrl(member.avatar || member.face || ''),
        followDays: 0,
        vip: Boolean(member.vip?.vipStatus),
        source: 'comment'
      });
    }
  }

  async fetchCommentParticipants(contentInput, options = {}) {
    const { keyword = '', mode = 3, maxPages = 500, onProgress } = options;

    if (onProgress) {
      onProgress({ phase: 'resolve', fetched: 0, total: 0, message: '正在解析视频/动态链接...' });
    }

    const target = await this.resolveContentTarget(contentInput);
    const label = target.contentKind === 'opus' ? '动态' : '视频';
    const byUid = new Map();
    let next = 0;
    let pageGuard = 0;
    let totalComments = 0;

    if (onProgress) {
      onProgress({
        phase: 'fetch',
        fetched: 0,
        total: 0,
        message: `正在拉取${label}「${target.title}」的评论...`
      });
    }

    while (pageGuard < maxPages) {
      const data = await this.apiGet(
        `${BILI_API}/x/v2/reply/main`,
        { type: String(target.type), oid: String(target.oid), mode: String(mode), next: String(next) },
        { headers: { Referer: target.referer } }
      );
      this.failIfApiError(data, `获取${label}评论失败`);

      for (const r of data.data?.replies || []) {
        this.addReplyParticipant(byUid, r, keyword);
      }

      const cursor = data.data?.cursor;
      totalComments = cursor?.all_count || totalComments;

      if (onProgress) {
        onProgress({
          phase: 'fetch',
          page: pageGuard + 1,
          fetched: byUid.size,
          total: totalComments,
          message: totalComments > 0
            ? `第 ${pageGuard + 1} 页 · 已获取 ${byUid.size} / ${totalComments} 位评论者`
            : `第 ${pageGuard + 1} 页 · 已获取 ${byUid.size} 位评论者`
        });
      }

      if (!cursor || cursor.is_end) break;
      next = cursor.next;
      pageGuard++;
      await sleep(280);
    }

    const fans = [...byUid.values()];

    if (onProgress) {
      onProgress({
        phase: 'done',
        fetched: fans.length,
        total: fans.length,
        message: `共获取 ${fans.length} 位评论参与者`
      });
    }

    return {
      fans,
      bilibiliTotal: fans.length,
      fetched: fans.length,
      apiMaxAutoFetch: null,
      limited: false,
      poolSource: 'comments',
      videoTitle: target.title,
      videoBvid: target.contentId,
      contentKind: target.contentKind
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
