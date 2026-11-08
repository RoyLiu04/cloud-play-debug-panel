// ==UserScript==
// @name         Xbox Cloud Gaming Unlock
// @namespace    https://github.com/RoyLiu04/xbox-cloud-unlock
// @version      3.1.0
// @description  让 play.xbox.com 在受限地区可用：改写市场判定与请求头，并提供串流链路设置（数据中心 / 强制 IPv4 / 画质）与迷你 QoS 读数
// @author       RoyLiu04
// @license      MIT
// @match        https://play.xbox.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/RoyLiu04/xbox-cloud-unlock/main/xbox-cloud-unlock.user.js
// @downloadURL  https://raw.githubusercontent.com/RoyLiu04/xbox-cloud-unlock/main/xbox-cloud-unlock.user.js
// @supportURL   https://github.com/RoyLiu04/xbox-cloud-unlock/issues
// ==/UserScript==

/*
 * 功能
 *   1. 地区解锁：改写 gears / xboxcomfd 的 experimentation 响应（trafficFilters.territory、market），
 *      并把 territory cookie 校正为所选地区，避免播放页把当前出口 IP 判成「不支持的市场」。
 *   2. 串流链路：可固定数据中心（改写 offeringSettings.regions 的 isDefault 与顺序）、
 *      剔除 ICE 中的 IPv6 候选（强制 IPv4）、按 settings.osName 选择画质档位
 *      （自动模式下视口高度 ≤ 900 视为小屏，直接压到 720p 档，避免掌机被推 1440p）。
 *   3. 状态读数：右下角小药丸显示实时丢包率，展开可看 RTT / 码率 / 分辨率 / 丢帧，并可切换上述设置。
 *
 * 工作方式
 *   页面自身发这几个请求，脚本只在 fetch / XHR 层改写响应与请求体，不修改页面代码：
 *     GET  gears.xboxservices.com/.../experimentation            → 决定 marketAccessContext.physicalMarket
 *     POST cloudgaming.gssv-play-*.xboxlive.com/v2/login/user    → 决定可用的串流数据中心
 *     POST <dc>.core.gssv-play-*.xboxlive.com/v5/sessions/cloud/play → 建会话
 *     GET  <dc>.core.../configuration、/ice                      → 媒体服务地址与 ICE 候选
 *
 * 隐私
 *   · 全部改写都在本机浏览器内完成，脚本不向外发送任何数据。
 *   · 面板的「复制报告」只包含版本、地区配置、链路统计与最近错误消息，
 *     不含页面内容、接口响应体或账号信息。
 *
 * 参考项目
 *   · redphx/better-xcloud — https://github.com/redphx/better-xcloud
 *     （regions 排序改写、osName 画质档位、x-ms-device-info 设备伪装、gssv 拦截方式）
 *   · darkchaox/xbox-cloud-gaming-optimizer — https://github.com/darkchaox/xbox-cloud-gaming-optimizer
 *     （旧版页面的地区解锁思路，本项目由此出发）
 *
 * 免责声明
 *   仅供学习与研究使用。绕过地区限制可能违反服务条款，使用风险与后果由使用者自行承担。
 */

(function () {
  'use strict';

  if (window.__XCU__ && window.__XCU__.v === '3.1.0') return;

  const VER = '3.1.0';
  const LS_KEY = 'xcu.region';       // 解锁地区（IP）
  const LS_SRV = 'xcu.streamRegion'; // 串流数据中心
  const LS_V4 = 'xcu.forceIPv4';     // 强制 IPv4
  const LS_RES = 'xcu.resolution';   // 画质档位

  // 出口 IP → 期望地区。下面的 IP 只是公开项目中常见的示例地址，
  // 换成你自己可用的出口地址即可（也可在面板里循环切换或直接写进 localStorage 的 xcu.region）。
  const REGIONS = {
    jp: { ip: '138.199.21.239', territory: 'JP', name: '日本' },
    us: { ip: '143.244.47.65', territory: 'US', name: '美国' },
    kr: { ip: '121.125.60.151', territory: 'KR', name: '韩国' },
    pl: { ip: '45.134.212.66', territory: 'PL', name: '波兰' },
    br: { ip: '169.150.198.66', territory: 'BR', name: '巴西' }
  };
  const DEFAULT_REGION = 'jp';

  // 串流数据中心：name 必须与服务端 offeringSettings.regions[].name 一致
  // 服务端 /v2/login/user 实际返回的 19 个区，亚洲只有东京、首尔两个真实可选
  const SERVERS = {
    auto: { name: '', label: '自动' },
    ejp: { name: 'JAPANEAST', label: '东京' },
    ckr: { name: 'KOREACENTRAL', label: '首尔' },
    eus: { name: 'EASTUS', label: '美东' },
    weu: { name: 'WESTEUROPE', label: '西欧' }
  };

  const RES_MODES = {
    auto: { osName: '', label: '自动' },
    r1080: { osName: 'windows', label: '1080p' },
    r720: { osName: 'android', label: '720p' }
  };

  // 小屏（掌机 800p、笔记本 768p 这类）上站点仍会协商到 1440p/1080p，
  // 多出来的分辨率既看不见又白烧带宽和电量，自动模式下直接压到 720p 档。
  const SMALL_H = 900;
  const SMALL_AUTO = { osName: 'android', label: '自动·720p' };

  function isSmallScreen() {
    try {
      return window.innerHeight > 0 && window.innerHeight <= SMALL_H;
    } catch (e) { return false; }
  }

  const GSSV_RE = /(^|\.)gssv-play-[a-z0-9-]*\.xboxlive\.com$/i;
  const GEARS_RE = /^gears(-staging)?\.xboxservices\.com$/i;
  const EXP_PATH_RE = /(\/Assignments\/experimentation|\/xboxcomfd\/experimentation)/i;
  const CAP_RE = /contentaccess|storepages|catalog\.gamepass|titlehub|emerald|gssv-play|gears/i;
  const MAX_CAP = 40;

  const S = {
    v: VER,
    all: 0,
    gssv: 0,
    inj: 0,
    caps: [],
    logs: [],
    env: {},
    territoryBefore: '',
    territoryNow: '',
    expHits: 0,
    expBefore: '(未经过)',
    expAfter: '(未经过)',
    cacheCleared: 0,
    denied: 0,
    // v2.2
    serverPin: '',
    serverActual: '',
    v6dropped: 0,
    resApplied: '',
    playPatched: 0,
    pcs: 0,
    qos: null,
    qosAt: 0,
    hist: [],
    histMin: null,
    startedAt: Date.now(),
    lastErr: ''
  };
  window.__XCU__ = S;

  // ---------- 配置 ----------
  function cfg() {
    let v = DEFAULT_REGION;
    try { v = localStorage.getItem(LS_KEY) || DEFAULT_REGION; } catch (e) { }
    if (v === 'off' || v === '0') return { key: 'off', ip: null, territory: null, name: '关闭' };
    if (REGIONS[v]) return Object.assign({ key: v }, REGIONS[v]);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
      return { key: 'custom', ip: v, territory: REGIONS[DEFAULT_REGION].territory, name: '自定义' };
    }
    return Object.assign({ key: DEFAULT_REGION }, REGIONS[DEFAULT_REGION]);
  }

  function getPref(k, def) {
    try { return localStorage.getItem(k) || def; } catch (e) { return def; }
  }
  function setPref(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { }
  }

  function srvCfg() {
    const k = getPref(LS_SRV, 'auto');
    if (SERVERS[k]) return SERVERS[k];
    if (/^[A-Z]{3,}$/.test(k)) return { name: k, label: k };
    return SERVERS.auto;
  }
  function resCfg() {
    const k = getPref(LS_RES, 'auto');
    const base = RES_MODES[k] || RES_MODES.auto;
    // 只有「自动」才按屏幕尺寸判断；手动选过 1080p / 720p 就尊重手动选择
    if (!base.osName && isSmallScreen()) return SMALL_AUTO;
    return base;
  }
  function v4on() { return getPref(LS_V4, '1') !== '0'; }

  function getCookie(n) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ---------- 一、清实验缓存（必须在页面脚本读之前）----------
  (function clearExpCache() {
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^experimentationInfo/i.test(k)) kill.push(k);
      }
      kill.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { } });
      S.cacheCleared = kill.length;
    } catch (e) { }
  })();

  // ---------- 二、territory ----------
  (function syncTerritory() {
    const c = cfg();
    S.territoryBefore = getCookie('territory') || '(无)';
    if (!c.territory) { S.territoryNow = S.territoryBefore; return; }
    if (S.territoryBefore === c.territory) { S.territoryNow = c.territory; return; }
    try {
      document.cookie = 'territory=' + encodeURIComponent(c.territory) + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (e) { }
    S.territoryNow = getCookie('territory') || '(写入失败)';
  })();

  // ---------- 三、环境 ----------
  try {
    S.env = {
      rtc: !!window.RTCPeerConnection,
      audio: !!(window.AudioContext || window.webkitAudioContext),
      online: navigator.onLine
    };
  } catch (e) { }

  function injectable(path) {
    return /\/v2\/login\/user$/i.test(path) || /\/sessions\//i.test(path);
  }

  function pushLog(kind, msg) {
    const s = String(msg);
    if (/Access to the streaming offering is denied/i.test(s)) S.denied++;
    S.logs.push({ t: new Date().toISOString().slice(11, 19), kind: kind, msg: s.slice(0, 400) });
    if (S.logs.length > 40) S.logs.shift();
    schedule();
  }

  function addCap(rec) {
    S.caps.push(rec);
    if (S.caps.length > MAX_CAP) S.caps.shift();
    schedule();
  }

  function nowStr() { return new Date().toISOString().slice(11, 19); }

  // ---------- 四、通用 JSON 响应改写 ----------
  function rewriteJson(res, fn) {
    let copy;
    try { copy = res.clone(); } catch (e) { return Promise.resolve(res); }
    return copy.text().then(function (txt) {
      let j;
      try { j = JSON.parse(txt); } catch (e) { return res; }
      let changed = false;
      try { changed = fn(j) === true; } catch (e) { S.lastErr = String(e && e.message || e); return res; }
      if (!changed) return res;
      const h = new Headers(res.headers);
      h.delete('content-length');
      h.delete('content-encoding');
      h.set('content-type', 'application/json; charset=utf-8');
      try {
        return new Response(JSON.stringify(j), {
          status: res.status, statusText: res.statusText, headers: h
        });
      } catch (e) { return res; }
    }, function () { return res; });
  }

  // ---------- 五、解锁：实验接口改写（physicalMarket）----------
  function rewriteExp(res, u) {
    if (!res || !res.status || res.status < 200 || res.status >= 300) return Promise.resolve(res);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('json') < 0) return Promise.resolve(res);
    const c = cfg();
    if (!c.territory) return Promise.resolve(res);

    return rewriteJson(res, function (j) {
      const holder = (j && typeof j === 'object' && j.exp && typeof j.exp === 'object') ? j.exp : j;
      if (!holder || typeof holder !== 'object') return false;
      const tf = holder.trafficFilters;
      if (!tf || typeof tf !== 'object') return false;

      const before = String(tf.territory == null ? '(空)' : tf.territory);
      S.expHits++;
      S.expBefore = before;
      S.expAfter = c.territory;

      tf.territory = c.territory;
      if (Object.prototype.hasOwnProperty.call(tf, 'market')) tf.market = c.territory;

      addCap({
        at: nowStr(), method: 'REWRITE', host: u.host,
        path: u.pathname + (u.search || ''), status: res.status,
        type: 'patched', body: 'physicalMarket: ' + before + ' -> ' + c.territory
      });
      return true;
    });
  }

  // ---------- 六、指定数据中心：改写 offeringSettings.regions ----------
  function rewriteRegions(res, u) {
    const want = srvCfg();
    if (!want.name) return Promise.resolve(res);

    return rewriteJson(res, function (j) {
      const os = j && j.offeringSettings;
      if (!os || !Array.isArray(os.regions) || !os.regions.length) return false;

      const hit = os.regions.filter(function (r) {
        return String(r && r.name).toUpperCase() === want.name;
      })[0];
      if (!hit) {
        S.serverActual = '该区不可用';
        addCap({
          at: nowStr(), host: u.host, path: u.pathname, status: res.status,
          type: 'patched', body: '目标区 ' + want.name + ' 不在列表中（可选：' +
            os.regions.map(function (r) { return r.name; }).join(',') + '）'
        });
        return false;
      }

      const rest = os.regions.filter(function (r) { return r !== hit; });
      // 客户端逻辑：isDefault 的 unshift 到队首，随后取 regions[0]。既能固定又不丢兜底。
      hit.isDefault = true;
      rest.forEach(function (r) { r.isDefault = false; });
      os.regions = [hit].concat(rest);

      S.serverPin = want.name;
      S.serverActual = want.name;
      addCap({
        at: nowStr(), host: u.host, path: u.pathname, status: res.status,
        type: 'patched', body: 'streamRegion -> ' + want.name + '（' + want.label + '）'
      });
      return true;
    });
  }

  // ---------- 七、强制 IPv4：剔除 IPv6 ICE 候选 ----------
  function isV6Candidate(cand) {
    // 形如 "a=candidate:1 1 UDP 100 192.0.2.10 1040 typ host"，第 5 段是地址
    const parts = String(cand).trim().split(/\s+/);
    const ip = parts[4] || '';
    return ip.indexOf(':') >= 0;
  }

  function rewriteIce(res, u, isSdp) {
    if (!res || !res.status || res.status < 200 || res.status >= 300) return Promise.resolve(res);
    if (!v4on()) return Promise.resolve(res);

    return rewriteJson(res, function (j) {
      const raw = j && j.exchangeResponse;
      if (typeof raw !== 'string' || !raw) return false;
      let inner;
      try { inner = JSON.parse(raw); } catch (e) { return false; }
      let dropped = 0;

      if (isSdp) {
        const sdp = inner && inner.sdp;
        if (typeof sdp !== 'string') return false;
        const lines = sdp.split(/\r\n|\n/);
        const keep = lines.filter(function (ln) {
          if (/^a=candidate:/i.test(ln) && isV6Candidate(ln.replace(/^a=/, ''))) { dropped++; return false; }
          return true;
        });
        if (!dropped) return false;
        inner.sdp = keep.join('\r\n');
      } else {
        if (!Array.isArray(inner)) return false;
        const keep = inner.filter(function (c) {
          const s = c && (c.candidate || '');
          if (/end-of-candidates/i.test(s)) return true;
          if (s && isV6Candidate(s)) { dropped++; return false; }
          return true;
        });
        if (!dropped) return false;
        inner = keep;
      }

      S.v6dropped += dropped;
      j.exchangeResponse = JSON.stringify(inner);
      addCap({
        at: nowStr(), host: u.host, path: u.pathname, status: res.status,
        type: 'patched', body: '剔除 IPv6 候选 ' + dropped + ' 条（累计 ' + S.v6dropped + '）'
      });
      return true;
    });
  }

  // ---------- 八、画质档位：改写 /sessions/cloud/play 请求体 ----------
  function patchPlayRequest(input, init) {
    const r = resCfg();
    if (!r.osName) return Promise.resolve({ input: input, init: init });
    try {
      const raw = typeof input === 'string' ? input
        : (input instanceof URL ? input.href : (input && input.url) || '');
      const abs = new URL(raw, location.href);
      const req = new Request((input instanceof Request) ? input : abs.href, init);
      if (!/^POST$/i.test(req.method)) return Promise.resolve({ input: input, init: init });
      return req.clone().text().then(function (txt) {
        let j;
        try { j = JSON.parse(txt); } catch (e) { return { input: input, init: init }; }
        if (!j || !j.settings || typeof j.settings !== 'object') {
          return { input: input, init: init };
        }
        j.settings.osName = r.osName;
        const h = new Headers(req.headers);
        h.delete('content-length');
        const di = h.get('x-ms-device-info');
        if (di) {
          try {
            const dj = JSON.parse(di);
            if (dj && dj.dev && dj.dev.os) dj.dev.os.name = r.osName;
            h.set('x-ms-device-info', JSON.stringify(dj));
          } catch (e) { }
        }
        S.resApplied = r.label;
        S.playPatched++;
        addCap({
          at: nowStr(), method: 'PATCH', host: abs.host, path: abs.pathname, status: 0,
          type: 'patched', body: 'settings.osName -> ' + r.osName + '（' + r.label + '）'
        });
        return {
          input: abs.href,
          init: {
            method: req.method,
            headers: h,
            body: JSON.stringify(j),
            mode: req.mode, credentials: req.credentials, cache: req.cache,
            redirect: req.redirect, referrer: req.referrer, integrity: req.integrity
          }
        };
      }).catch(function () { return { input: input, init: init }; });
    } catch (e) {
      return Promise.resolve({ input: input, init: init });
    }
  }

  // ---------- 九、fetch hook ----------
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      let u = null;
      try {
        const raw = typeof input === 'string'
          ? input
          : (input instanceof URL ? input.href : (input && input.url) || '');
        if (raw) {
          u = new URL(raw, location.href);
          S.all++;

          if (GSSV_RE.test(u.host)) {
            S.gssv++;
            const c = cfg();
            if (c.ip && injectable(u.pathname)) {
              if (input instanceof Request) {
                const h = new Headers(input.headers);
                if (!h.has('X-Forwarded-For')) {
                  h.set('X-Forwarded-For', c.ip);
                  input = new Request(input, { headers: h });
                  S.inj++;
                }
              } else {
                const h = new Headers((init && init.headers) || {});
                if (!h.has('X-Forwarded-For')) {
                  h.set('X-Forwarded-For', c.ip);
                  init = Object.assign({}, init, { headers: h });
                  S.inj++;
                }
              }
            }
          }
          schedule();
        }
      } catch (e) { S.lastErr = String((e && e.message) || e); }

      const isPlay = !!(u && GSSV_RE.test(u.host) && /\/v5\/sessions\/cloud\/play$/i.test(u.pathname));
      if (isPlay) {
        const m = /^([a-z0-9]+)\.core\./i.exec(u.host);
        if (m) S.serverActual = m[1].toUpperCase();
      }

      const go = isPlay
        ? patchPlayRequest(input, init).then(function (x) { return nativeFetch.call(this, x.input, x.init); }.bind(this))
        : nativeFetch.call(this, input, init);

      let p = go;

      const isExp = !!(u && GEARS_RE.test(u.host) && EXP_PATH_RE.test(u.pathname));
      const isExp2 = !!(u && EXP_PATH_RE.test(u.pathname) && /xboxservices\.com$/i.test(u.host));

      if (isExp || isExp2) {
        p = p.then(function (res) { return rewriteExp(res, u); }, function (err) { throw err; });
      }

      if (u && GSSV_RE.test(u.host) && /\/v2\/login\/user$/i.test(u.pathname)) {
        p = p.then(function (res) {
          if (res.status !== 200) return res;
          return rewriteRegions(res, u);
        }, function (err) { throw err; });
      }

      if (u && GSSV_RE.test(u.host) && /\/sdp$/i.test(u.pathname)) {
        p = p.then(function (res) { return rewriteIce(res, u, true); }, function (err) { throw err; });
      }
      if (u && GSSV_RE.test(u.host) && /\/ice$/i.test(u.pathname)) {
        p = p.then(function (res) { return rewriteIce(res, u, false); }, function (err) { throw err; });
      }

      if (u && CAP_RE.test(u.host) && !isExp && !isExp2) {
        p.then(function (res) {
          const rec = {
            at: nowStr(),
            method: (init && init.method) || (input instanceof Request ? input.method : 'GET'),
            host: u.host,
            path: u.pathname + u.search,
            status: res.status,
            type: res.type
          };
          addCap(rec);
        }, function (err) {
          addCap({
            at: nowStr(), host: u.host, path: u.pathname + u.search,
            status: 0, type: 'failed', note: String((err && err.message) || err)
          });
        });
      }

      return p;
    };
  }

  // ---------- 十、QoS 采样（包一层 RTCPeerConnection）----------
  (function hookRtc() {
    try {
      const OPC = window.RTCPeerConnection;
      if (typeof OPC !== 'function') return;

      const W = function () {
        const pc = new OPC(...arguments);
        try {
          S.pcs++; S.lastPc = pc;
          // 新会话：先把上一局落库做 A/B 对比，再重置采样基线
          if (S.pcs > 1) { prevSnap = null; S.hist = []; S.histMin = null; S.qos = null; }
        } catch (e) { }
        return pc;
      };
      W.prototype = OPC.prototype;
      ['generateCertificate', 'getStats'].forEach(function (k) {
        if (OPC[k]) W[k] = OPC[k];
      });
      window.RTCPeerConnection = W;
      if (window.webkitRTCPeerConnection === OPC) window.webkitRTCPeerConnection = W;
    } catch (e) { }
  })();

  let qosBusy = false, prevSnap = null;

  function pumpQos() {
    const pc = S.lastPc;
    if (qosBusy || !pc || typeof pc.getStats !== 'function') return;
    qosBusy = true;
    PCQos(pc).then(function (q) {
      if (q) { S.qos = q; S.qosAt = Date.now(); schedule(); }
    }, function () { }).then(function () { qosBusy = false; });
  }

  function PCQos(pc) {
    let stats;
    try { stats = pc.getStats(); } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(stats).then(function (rep) {
      const out = {};
      let video = null, pair = null, pairId = null;

      rep.forEach(function (r) {
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) video = r;
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r;
      });
      if (pairId && rep.get) {
        const p2 = rep.get(pairId);
        if (p2) pair = p2;
      }
      if (!video && !pair) return null;

      if (video) {
        const recv = video.packetsReceived || 0;
        const lost = video.packetsLost || 0;
        out.loss = (recv + lost) > 0 ? (lost / (recv + lost) * 100) : 0;
        out.recv = recv;
        out.lost = lost;
        out.w = video.frameWidth || 0;
        out.h = video.frameHeight || 0;
        out.fps = Math.round(video.framesPerSecond || 0);
        out.jitter = video.jitter != null ? Math.round(video.jitter * 1000) : null;
        out.bytes = video.bytesReceived || 0;
        out.ts = video.timestamp || Date.now();
        // 解码侧指标：区分「网络丢包」和「本机解码/渲染跟不上」
        out.dropped = video.framesDropped || 0;
        out.freeze = video.freezeCount || 0;
        out.freezeDur = Math.round(video.totalFreezesDuration || 0);
        out.decoded = video.framesDecoded || 0;
        if (video.codecId && rep.get) {
          const cc = rep.get(video.codecId);
          if (cc && cc.mimeType) out.codec = String(cc.mimeType).replace(/^video\//i, '').toUpperCase();
        }
        if (video.jitterBufferDelay != null && video.jitterBufferEmittedCount) {
          out.bufMs = Math.round(video.jitterBufferDelay / video.jitterBufferEmittedCount * 1000);
        }

        if (prevSnap && prevSnap.bytes != null) {
          const dB = out.bytes - prevSnap.bytes;
          const dT = (out.ts - prevSnap.ts) / 1000;
          if (dT > 0.5 && dB >= 0) out.kbps = Math.round(dB * 8 / dT / 1000);

          // 瞬时丢包率：只统计这段采样区间，累计值会把改善掩盖掉
          const dRecv = recv - prevSnap.recv;
          const dLost = lost - prevSnap.lost;
          if (dRecv + dLost > 20 && dRecv >= 0 && dLost >= 0) {
            out.instLoss = dLost / (dRecv + dLost) * 100;
            S.hist.push(Math.round(out.instLoss * 10) / 10);
            if (S.hist.length > 12) S.hist.shift();
            S.histMin = S.histMin == null ? out.instLoss : Math.min(S.histMin, out.instLoss);
            out.hist = S.hist.slice(-6);
            out.histMin = Math.round(S.histMin * 10) / 10;
          }
        }
        prevSnap = { bytes: out.bytes, ts: out.ts, recv: recv, lost: lost };
      }

      if (pair) {
        out.rtt = pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null;
        out.lostReq = pair.requestsFailed || 0;
        const rc = rep.get ? rep.get(pair.remoteCandidateId) : null;
        if (rc) {
          out.remote = rc.address || '';
          out.port = rc.port || '';
          out.family = (out.remote.indexOf(':') >= 0) ? 'IPv6' : 'IPv4';
          out.ctype = rc.candidateType || rc.type || '';
        }
        // 本端候选：如果这里是公网 IP 且不在代理出口同侧，说明媒体流没走代理（WebRTC 泄漏直连）
        const lc = rep.get ? rep.get(pair.localCandidateId) : null;
        if (lc) {
          out.local = lc.address || '';
          out.ltype = lc.candidateType || lc.type || '';
          out.lproto = lc.protocol || '';
          out.lport = lc.port || '';
        }
        out.proto = pair.protocol || (lc && lc.protocol) || '';
      }
      return out;
    }, function () { return null; });
  }

  // ---------- 十一、XHR ----------
  try {
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      xhr.addEventListener('loadend', function () {
        try {
          const u = new URL(xhr.responseURL || '', location.href);
          if (!CAP_RE.test(u.host)) return;
          addCap({
            at: nowStr(), method: 'XHR', host: u.host,
            path: u.pathname + u.search, status: xhr.status, type: 'xhr'
          });
        } catch (e) { }
      });
      return oSend.apply(xhr, arguments);
    };
  } catch (e) { }

  // ---------- 十二、异常记录（只留消息，不记录页面内容）----------
  try {
    window.addEventListener('error', function (e) {
      pushLog('error', (e.message || '') + ' @ line ' + (e.lineno || 0));
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      const r = e.reason;
      pushLog('reject', (r && (r.message || r)) || '');
    });
  } catch (e) { }

  // ---------- 十三、UI：一个小药丸 + 可折叠卡片 ----------
  // 设计约束（v3.0 起）：
  //   · 默认收成一个 ~24px 高的小药丸，放右下角，避开站点左侧边栏和「设置」
  //   · 外层容器 pointer-events:none，只有药丸/卡片本身可点 —— 绝不拦截页面点击
  //   · 可拖动，位置记在 localStorage
  //   · 进入串流自动收起；站点弹出对话框（设置/购买）时卡片自动让开
  const LS_POS = 'xcu.pos';
  const ZBASE = 2147483000;
  const MONO = 'ui-monospace,Menlo,Consolas,monospace';

  let wrap = null, pillEl = null, cardEl = null, dotEl = null, pillTxt = null;
  let openUI = false, userTouched = false, autoFolded = false, pending = false;
  const el = {};

  function readPos() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_POS) || 'null');
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) { }
    return null;
  }

  function mk(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function bindDrag(node, onTap) {
    node.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      const r = wrap.getBoundingClientRect();
      const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
      let moved = false;
      function mv(e2) {
        if (!moved && Math.abs(e2.clientX - ev.clientX) + Math.abs(e2.clientY - ev.clientY) < 3) return;
        moved = true;
        const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, e2.clientX - dx));
        const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, e2.clientY - dy));
        wrap.style.right = 'auto';
        wrap.style.bottom = 'auto';
        wrap.style.left = x + 'px';
        wrap.style.top = y + 'px';
      }
      function up() {
        window.removeEventListener('pointermove', mv, true);
        window.removeEventListener('pointerup', up, true);
        if (moved) {
          try {
            localStorage.setItem(LS_POS, JSON.stringify({
              x: parseFloat(wrap.style.left), y: parseFloat(wrap.style.top)
            }));
          } catch (e) { }
        } else if (onTap) { onTap(); }
      }
      window.addEventListener('pointermove', mv, true);
      window.addEventListener('pointerup', up, true);
      ev.stopPropagation();
    });
  }

  function pillBtn(text, fn) {
    const b = mk('button', [
      'all:unset', 'cursor:pointer', 'padding:3px 8px', 'border-radius:6px',
      'border:1px solid #30363d', 'background:#161b22', 'color:#c9d1d9',
      'font:11px/1.2 ' + MONO, 'white-space:nowrap'
    ].join(';'), text);
    b.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    b.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); fn(); });
    return b;
  }

  function buildUI() {
    if (wrap) return wrap;
    const host = mountTarget() || document.documentElement;
    if (!host) return null;

    wrap = mk('div', 'position:fixed;right:12px;bottom:64px;z-index:' + ZBASE + ';pointer-events:none;' +
      'font:11px/1.5 ' + MONO + ';color:#c9d1d9;text-align:right');
    wrap.id = '__xcu_panel__';
    const saved = readPos();
    if (saved) {
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
      wrap.style.left = saved.x + 'px';
      wrap.style.top = saved.y + 'px';
    }

    // 药丸
    pillEl = mk('div', [
      'pointer-events:auto', 'display:inline-flex', 'align-items:center', 'gap:5px',
      'padding:3px 9px', 'height:24px', 'box-sizing:border-box', 'border-radius:12px',
      'background:rgba(13,17,23,.92)', 'border:1px solid #30363d', 'cursor:grab',
      'user-select:none', 'box-shadow:0 2px 10px rgba(0,0,0,.45)', 'white-space:nowrap'
    ].join(';'));
    dotEl = mk('span', 'width:7px;height:7px;border-radius:50%;background:#8b949e;flex:0 0 auto');
    pillTxt = mk('span', 'color:#c9d1d9', 'xCloud');
    pillEl.title = '单击展开 · 按住可拖动';
    pillEl.appendChild(dotEl);
    pillEl.appendChild(pillTxt);
    wrap.appendChild(pillEl);
    bindDrag(pillEl, function () { setOpen(!openUI, true); });

    // 卡片
    cardEl = mk('div', [
      'pointer-events:auto', 'display:none', 'margin-top:6px', 'width:260px',
      'max-width:calc(100vw - 24px)', 'box-sizing:border-box', 'text-align:left',
      'background:rgba(13,17,23,.96)', 'border:1px solid #30363d', 'border-radius:10px',
      'padding:8px 9px 9px', 'box-shadow:0 8px 26px rgba(0,0,0,.55)'
    ].join(';'));

    const head = mk('div', 'display:flex;align-items:center;justify-content:space-between;' +
      'margin-bottom:5px;cursor:move;user-select:none');
    head.appendChild(mk('span', 'font-weight:700;color:#e6edf3', 'xCloud 解锁 v' + VER));
    const closeBtn = mk('span', 'cursor:pointer;color:#8b949e;padding:0 3px;font-size:14px;line-height:1', '×');
    closeBtn.title = '收起';
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(false, true); });
    head.appendChild(closeBtn);
    cardEl.appendChild(head);
    bindDrag(head, null);

    el.status = mk('div', 'line-height:1.6');
    el.qos = mk('div', 'line-height:1.6;margin-top:3px');
    el.hint = mk('div', 'margin-top:3px;color:#d29922;font-size:10px;line-height:1.45;display:none');
    cardEl.appendChild(el.status);
    cardEl.appendChild(el.qos);
    cardEl.appendChild(el.hint);

    const row1 = mk('div', 'display:flex;gap:5px;flex-wrap:wrap;margin-top:7px');
    el.btnSrv = pillBtn('数据中心', cycleServer);
    el.btnRes = pillBtn('画质', cycleRes);
    el.btnV4 = pillBtn('IPv4', toggleV4);
    el.btnRegion = pillBtn('地区', cycleRegion);
    row1.appendChild(el.btnSrv);
    row1.appendChild(el.btnRes);
    row1.appendChild(el.btnV4);
    row1.appendChild(el.btnRegion);
    cardEl.appendChild(row1);

    const row2 = mk('div', 'display:flex;gap:5px;flex-wrap:wrap;margin-top:5px');
    const copyBtn = pillBtn('复制报告', copyAll);
    const resetBtn = pillBtn('清缓存重载', hardReload);
    copyBtn.style.flex = '1';
    row2.appendChild(copyBtn);
    row2.appendChild(resetBtn);
    cardEl.appendChild(row2);

    wrap.appendChild(cardEl);
    host.appendChild(wrap);
    return wrap;
  }

  function setOpen(v, byUser) {
    openUI = !!v;
    if (byUser) userTouched = true;
    if (!cardEl) return;
    cardEl.style.display = openUI ? 'block' : 'none';
    if (openUI) update();
  }

  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(function () { pending = false; update(); }, 150);
  }

  function isPrivateIp(ip) {
    return /^10\./.test(ip) || /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip) || /^127\./.test(ip);
  }

  function hintOne(q, loss) {
    if (!q) return '';
    if (loss != null && loss > 5) {
      if (!v4on()) return '丢包偏高：先点「IPv4」切回强制';
      if (srvCfg().name !== 'JAPANEAST') return '丢包 ' + loss.toFixed(1) + '%：点「数据中心」换东京再比一局';
      return '东京也丢 ' + loss.toFixed(1) + '% → 线路问题，不是画质或数据中心';
    }
    if (q.decoded || q.dropped) {
      const dr = q.dropped / ((q.decoded + q.dropped) || 1) * 100;
      if (dr > 5 && (loss == null || loss < 3)) return '丢帧 ' + dr.toFixed(1) + '% 但丢包不高 → 本机解码跟不上';
    }
    if (q.family === 'IPv6') return '正在走 IPv6，可点「IPv4」切换对比';
    if (loss != null && loss < 2) return '';
    return '';
  }

  function update() {
    if (!buildUI()) return;

    const c = cfg();
    const q = S.qos;
    const loss = q ? (q.instLoss != null ? q.instLoss : (q.loss || 0)) : null;

    // 药丸只显示丢包，颜色即状态
    dotEl.style.background = loss == null ? '#8b949e' : (loss < 2 ? '#3fb950' : (loss < 5 ? '#d29922' : '#f85149'));
    pillTxt.textContent = loss == null ? 'xCloud' : loss.toFixed(1) + '%';

    if (!openUI) return;

    const curT = getCookie('territory') || '无';
    const wantT = c.territory || '';
    const okT = wantT ? String(curT).toUpperCase() === wantT.toUpperCase() : true;
    const expAfter = String(S.expAfter || '?');
    const okIp = wantT ? expAfter.toUpperCase() === wantT.toUpperCase() : true;

    el.status.innerHTML =
      '地区 <b style="color:#e6edf3">' + c.name + '</b>' +
      ' · territory <b style="color:' + (okT ? '#3fb950' : '#d29922') + '">' + curT + '</b>' +
      ' · IP <b style="color:' + (okIp ? '#3fb950' : '#f85149') + '">' + expAfter + '</b>';

    if (!q) {
      el.qos.innerHTML = '<span style="color:#8b949e">未进入串流（可正常开游戏）</span>';
      el.hint.style.display = 'none';
    } else {
      const col = loss < 2 ? '#3fb950' : (loss < 5 ? '#d29922' : '#f85149');
      const dr = (q.decoded || q.dropped) ? (q.dropped / ((q.decoded + q.dropped) || 1) * 100) : null;
      el.qos.innerHTML =
        '丢包 <b style="color:' + col + '">' + loss.toFixed(1) + '%</b>' +
        (q.rtt != null ? ' · <b>' + q.rtt + 'ms</b>' : '') +
        (q.kbps ? ' · ' + (q.kbps / 1000).toFixed(1) + 'Mbps' : '') +
        (q.w ? ' · ' + q.h + 'p' : '') +
        '<br><span style="color:#8b949e">' + (S.serverActual || '自动') +
        (q.family ? ' · ' + q.family : '') +
        (q.codec ? ' · ' + q.codec : '') +
        (dr != null ? ' · 丢帧 ' + dr.toFixed(1) + '%' : '') + '</span>';

      const h = hintOne(q, loss);
      if (h) { el.hint.textContent = '⚠ ' + h; el.hint.style.display = 'block'; }
      else el.hint.style.display = 'none';
    }

    el.btnSrv.textContent = '数据中心 ' + srvCfg().label;
    el.btnRes.textContent = '画质 ' + resCfg().label;
    el.btnV4.textContent = 'IPv4 ' + (v4on() ? '强制' : '关');
    el.btnRegion.textContent = '地区 ' + c.name;
  }

  // ---------- 十四、设置（直接循环，不弹 prompt，避免全屏下被拦）----------
  function cycleServer() {
    const keys = Object.keys(SERVERS);
    const cur = getPref(LS_SRV, 'auto');
    const i = Math.max(0, keys.indexOf(cur));
    const next = keys[(i + 1) % keys.length];
    setPref(LS_SRV, next);
    S.serverActual = '';
    S.serverPin = SERVERS[next].name;
    update();
  }

  function cycleRes() {
    const keys = Object.keys(RES_MODES);
    const cur = getPref(LS_RES, 'auto');
    const i = Math.max(0, keys.indexOf(cur));
    setPref(LS_RES, keys[(i + 1) % keys.length]);
    update();
  }

  function toggleV4() {
    setPref(LS_V4, v4on() ? '0' : '1');
    S.v6dropped = 0;
    update();
  }

  function cycleRegion() {
    const keys = Object.keys(REGIONS).concat(['off']);
    const cur = cfg().key;
    const i = Math.max(0, keys.indexOf(cur));
    const next = keys[(i + 1) % keys.length];
    setPref(LS_KEY, next);
    location.reload();
  }

  function hardReload() {
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^experimentationInfo|^HydrationCache/i.test(k)) kill.push(k);
      }
      kill.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { } });
    } catch (e) { }
    location.reload();
  }

  function buildReport() {
    return JSON.stringify({
      v: VER,
      url: location.href,
      region: cfg(),
      stream: { pin: S.serverPin, actual: S.serverActual, ipv4Only: v4on(), resolution: resCfg().label, playPatched: S.playPatched },
      territory: { before: S.territoryBefore, now: S.territoryNow, cookie: getCookie('territory') },
      experiment: { hits: S.expHits, before: S.expBefore, after: S.expAfter, cacheCleared: S.cacheCleared },
      media: { peerConnections: S.pcs, ipv6CandidatesDropped: S.v6dropped },
      qos: S.qos,
      qosHistory: { samples: S.hist, min: S.histMin },
      env: S.env,
      counts: {
        hookAll: S.all, gssv: S.gssv, injected: S.inj,
        captured: S.caps.length, deniedErrors: S.denied
      },
      logs: S.logs,
      captures: S.caps,
      lastErr: S.lastErr,
      elapsedSec: Math.round((Date.now() - S.startedAt) / 1000)
    }, null, 2);
  }

  function copyAll() {
    const t = buildReport();
    console.log(t);
    try {
      navigator.clipboard.writeText(t).then(
        function () { alert('报告已复制'); },
        function () { alert('复制失败，已打印到控制台'); }
      );
    } catch (e) { alert('复制失败，已打印到控制台'); }
  }

  // 串流开始后页面会调用 Fullscreen API 进入全屏。全屏状态下浏览器只渲染全屏元素及其后代，
  // 挂在 body 上的面板会被整块隐藏（Steam Deck / Game Mode 上表现为「进游戏后药丸消失，
  // 打开 Steam 指南打断全屏才又出现」）。所以面板要跟着全屏元素走。
  function fullscreenHost() {
    let fs = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fs) return null;
    try {
      if (fs.tagName === 'VIDEO') fs = fs.parentElement || fs.parentNode;
      if (fs && fs.nodeType === 1 && fs.appendChild) return fs;
    } catch (e) { }
    return null;
  }

  function mountTarget() {
    return fullscreenHost() || document.body;
  }

  // 站点对话框是否真的压到面板身上：只用「可见 + 与面板矩形相交」判定，
  // 避免框架常驻隐藏节点造成误判（误判会让面板一直看不见）。
  function modalHit() {
    if (!wrap) return false;
    let wr;
    try { wr = wrap.getBoundingClientRect(); } catch (e) { return false; }
    if (!wr.width) return false;
    try {
      const list = document.querySelectorAll('[aria-modal="true"],[role="dialog"]');
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (wrap.contains(n)) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 60 || r.height < 60) continue;
        // 覆盖大半个视口的容器是串流画面本体，不是对话框，不能让它把面板藏起来
        if (r.width > window.innerWidth * 0.7 && r.height > window.innerHeight * 0.7) continue;
        if (r.right > wr.left - 8 && r.left < wr.right + 8 &&
            r.bottom > wr.top - 8 && r.top < wr.bottom + 8) return true;
      }
    } catch (e) { }
    return false;
  }

  // ---------- 十五、主循环 ----------
  function tick() {
    try {
      const host = mountTarget();
      if (wrap && host && wrap.parentNode !== host) host.appendChild(wrap);
    } catch (e) { }

    // 进入串流后画面容器常带 role="dialog"，且全屏时面板已自动收起，
    // 药丸必须保持可见可点（Steam Deck 上要用手柄光标去点它）。
    // 用「最近 8 秒内还有 QoS 采样」而不是「曾经建过连接」来判定，
    // 否则退出串流后 S.pcs 不会归零，面板会永远不再给站点对话框让位。
    const streaming = !!(S.qosAt && (Date.now() - S.qosAt < 8000));
    const modal = streaming ? false : modalHit();
    if (cardEl) cardEl.style.display = (openUI && !modal) ? 'block' : 'none';
    if (pillEl) {
      pillEl.style.opacity = modal ? '.18' : '1';
      pillEl.style.pointerEvents = modal ? 'none' : 'auto';
    }

    // 首次进入串流自动收起，不挡游戏内控件
    if (!autoFolded && S.pcs > 0) {
      autoFolded = true;
      if (!userTouched) setOpen(false);
    }
    update();
  }

  function boot() {
    buildUI();
    update();
    // 进出全屏时立刻把面板搬到新的宿主里，不依赖 1.5s 的 tick
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        try {
          const host = mountTarget();
          if (wrap && host) host.appendChild(wrap);
        } catch (e) { }
      }, true);
    });
    setInterval(tick, 1500);
    setInterval(pumpQos, 2000);
    console.log('[xcu] v' + VER + ' 启动 | 数据中心', srvCfg().label, '| IPv4', v4on(), '| 画质', resCfg().label);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
