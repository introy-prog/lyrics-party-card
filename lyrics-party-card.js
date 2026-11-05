/* Lyrics Party card for Home Assistant
 * Time-synced lyrics (LRCLIB) for whatever a media_player is playing, with
 * album-art colors and music-styled visuals. Built to stay light on Fire TV.
 *
 * type: custom:lyrics-party-card
 * entity: media_player.living_room     # optional
 * entities: [media_player.a, media_player.b]   # optional pool for auto-follow
 * layout: card | fullscreen            # default fullscreen
 * height: 480px                        # card layout only
 * offset: 0.3                          # seconds; lyrics lead the audio slightly
 * visuals: full | lite | off
 * font_scale: 1
 * URL override: ?room=media_player.kitchen
 */
const LP_VERSION = '1.1.0';
const LP_API = 'https://lrclib.net/api/';
const LP_MISS_TTL = 60 * 60 * 1000;   // retry songs with no lyrics after an hour
const LP_RETRY_MS = 30 * 1000;
const LP_MAX_RETRIES = 3;

function lpClean(t) {
  return (t || '')
    .replace(/\s*[(\[][^)\]]*\b(remaster(ed)?|live|feat\.?|ft\.?|version|edit|mono|stereo|deluxe|bonus)\b[^)\]]*[)\]]/ig, '')
    .replace(/\s+-\s+.*\b(remaster(ed)?|live|version|edit|mix)\b.*$/i, '')
    .trim();
}

// Full credit first, so "Earth, Wind & Fire" stays intact; first credited artist as fallback.
function lpArtists(a) {
  const full = (a || '').trim();
  const first = full.split(/,|&| feat\.? | ft\.? /i)[0].trim();
  return first && first !== full ? [full, first] : [full];
}

function lpParseLrc(text) {
  const out = [];
  (text || '').split('\n').forEach(l => {
    const m = l.match(/^((?:\[\d+:\d+(?:\.\d+)?\])+)(.*)$/);
    if (!m) return;
    const x = m[2].replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const s of m[1].matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)) out.push({ t: +s[1] * 60 + +s[2], x });
  });
  return out.sort((a, b) => a.t - b.t);
}

function lpPick(exact, list, dur) {
  const near = x => !dur || !x.duration || Math.abs(x.duration - dur) <= 4;
  const L = Array.isArray(list) ? list : [];
  return (exact && exact.syncedLyrics ? exact : null) ||
    L.find(x => x.syncedLyrics && near(x)) ||
    L.find(x => x.syncedLyrics) ||
    (exact && exact.plainLyrics ? exact : null) ||
    L.find(x => x.plainLyrics) ||
    (exact && exact.instrumental ? exact : null) ||
    L.find(x => x.instrumental && near(x)) || null;
}

async function lpLookup(title, artist, dur, fetchFn, timeoutMs) {
  const qs = p => Object.entries(p).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const j = u => fetchFn(u).then(r => r.ok ? { body: r.json() } : { body: null, failed: r.status !== 404 })
    .then(async r => ({ body: await r.body, failed: !!r.failed }))
    .catch(() => ({ body: null, failed: true }));
  // search is fast and cached; exact get can be slow, so it gets a time limit
  const [list, exact] = await Promise.all([
    j(LP_API + 'search?' + qs({ track_name: title, artist_name: artist })),
    Promise.race([j(LP_API + 'get?' + qs({ track_name: title, artist_name: artist, duration: dur || '' })),
      new Promise(r => setTimeout(() => r({ body: null, failed: false }), timeoutMs))])
  ]);
  return { data: lpPick(exact.body, list.body, dur), failed: list.failed };
}

async function lpFindLyrics(rawTitle, rawArtist, dur, fetchFn, timeoutMs) {
  const f = fetchFn || ((u) => fetch(u));
  const title = lpClean(rawTitle), artists = lpArtists(rawArtist);
  const tries = artists.map(artist => ({ title, artist }));
  if (rawTitle !== title) tries.push({ title: rawTitle, artist: artists[0] });
  let best = null, failed = false;
  for (const t of tries) {
    const r = await lpLookup(t.title, t.artist, dur, f, timeoutMs === undefined ? 6000 : timeoutMs);
    failed = failed || r.failed;
    if (r.data && (r.data.syncedLyrics || r.data.instrumental)) return { data: r.data, failed: false };
    if (r.data && !best) best = r.data;
  }
  return { data: best, failed: !best && failed };
}

class LyricsPartyCard extends HTMLElement {
  static getConfigElement() { return document.createElement('lyrics-party-card-editor'); }
  static getStubConfig() { return { layout: 'card', visuals: 'full', offset: 0.3 }; }

  setConfig(config) {
    const c = Object.assign({ offset: 0.3, visuals: 'full', layout: 'fullscreen', height: '480px', font_scale: 1 }, config || {});
    if (!Array.isArray(c.entities) || !c.entities.length) delete c.entities;
    this._config = c;
    this._key = null;
    this._lines = null;
    this._plain = null;
    this._idx = -1;
    this._status = 'idle';
    this._color = this._color || [40, 30, 80];
    if (!this._root) this._build();
    this._applyConfig();
    if (this._hass) this.hass = this._hass;
  }

  set hass(hass) {
    this._hass = hass;
    const prev = this._ent, ent = this._pickEntity();
    this._ent = ent;
    const st = ent ? hass.states[ent] : null;
    this._st = st;
    if (!st) { this._key = null; this._renderMeta(); return; }
    const a = st.attributes;
    const key = [a.media_title, a.media_artist, Math.round(a.media_duration || 0)].join('|');
    if (key !== this._key) {
      this._key = key;
      this._idx = -1;
      this._renderMeta();
      this._loadLyrics(a);
      this._loadColor(a.entity_picture);
    } else if (ent !== prev) {
      this._renderMeta();
    }
  }

  _pickEntity() {
    const q = new URLSearchParams(window.location.search).get('room');
    const h = this._hass;
    if (q && h.states[q]) return q;
    if (this._config.entity && !this._config.entities) return this._config.entity;
    let pool = this._config.entities;
    if (!pool) pool = Object.keys(h.states).filter(e => e.startsWith('media_player.') &&
      ('media_title' in h.states[e].attributes || h.states[e].attributes.device_class === 'speaker'));
    const playing = pool.filter(e => h.states[e] && h.states[e].state === 'playing' && h.states[e].attributes.media_title);
    if (this._ent && playing.includes(this._ent)) return this._ent;
    return playing[0] || this._config.entity || pool.find(e => h.states[e] && h.states[e].attributes.media_title) || null;
  }

  _build() {
    this._root = this.attachShadow({ mode: 'open' });
    const bars = Array.from({ length: 28 }, () =>
      `<i style="animation-duration:${(0.55 + Math.random() * 0.9).toFixed(2)}s;animation-delay:-${(Math.random()).toFixed(2)}s"></i>`).join('');
    this._root.innerHTML = `
<style>
  :host{display:block;height:100%;}
  /* --vh, --vw and --vmax are 1% of the card itself, set by a ResizeObserver */
  .wrap{--vh:1vh;--vw:1vw;--vmax:1vmax;--fs:1;position:relative;overflow:hidden;height:100vh;min-height:280px;color:#fff;
    font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#111;}
  .wrap.card{border-radius:var(--ha-card-border-radius,12px);}
  .bg{position:absolute;inset:0;transition:background 1.5s ease;}
  .glow{position:absolute;width:calc(var(--vmax)*70);height:calc(var(--vmax)*70);left:50%;top:55%;transform:translate(-50%,-50%);
    border-radius:50%;opacity:.45;transition:background 1.5s ease;animation:breathe 6s ease-in-out infinite;}
  @keyframes breathe{0%,100%{transform:translate(-50%,-50%) scale(.9)}50%{transform:translate(-50%,-50%) scale(1.08)}}
  .pulse .glow{animation:breathe 6s ease-in-out infinite, kick .45s ease-out 1;}
  @keyframes kick{0%{opacity:.75}100%{opacity:.45}}
  .bars{position:absolute;left:0;right:0;bottom:0;height:calc(var(--vh)*15);display:flex;align-items:flex-end;gap:calc(var(--vw)*.6);
    padding:0 calc(var(--vw)*3);opacity:.22;}
  .bars i{flex:1;height:100%;border-radius:6px 6px 0 0;background:var(--accent);transform-origin:bottom;
    animation:bounce ease-in-out infinite alternate;}
  @keyframes bounce{0%{transform:scaleY(.08)}100%{transform:scaleY(1)}}
  .paused .bars i,.paused .glow{animation-play-state:paused;}
  .lite .glow{animation:none}.off .bars,.off .glow{display:none}
  .head{position:absolute;top:calc(var(--vh)*3);left:calc(var(--vw)*3);right:calc(var(--vw)*3);display:flex;align-items:center;gap:calc(var(--vw)*2);z-index:2;}
  .art{width:calc(var(--vh)*13);height:calc(var(--vh)*13);border-radius:12px;background:#333 center/cover;box-shadow:0 6px 24px rgba(0,0,0,.5);flex:none;}
  .title{font-size:calc(var(--vh)*4.2);font-weight:700;line-height:1.15;}
  .artist{font-size:calc(var(--vh)*3);opacity:.8;margin-top:calc(var(--vh)*.4);}
  .room{margin-left:auto;font-size:calc(var(--vh)*2.2);opacity:.6;text-align:right;}
  .lyr{position:absolute;left:calc(var(--vw)*5);right:calc(var(--vw)*5);top:calc(var(--vh)*20);bottom:calc(var(--vh)*12);overflow:hidden;z-index:2;
    -webkit-mask-image:linear-gradient(transparent 0,#000 18%,#000 72%,transparent 100%);
    mask-image:linear-gradient(transparent 0,#000 18%,#000 72%,transparent 100%);}
  .track{transition:transform .6s cubic-bezier(.2,.7,.2,1);will-change:transform;}
  .ln{font-size:calc(var(--vh)*4.6*var(--fs));font-weight:700;line-height:1.35;padding:calc(var(--vh)*.5) 0;opacity:.32;transition:opacity .4s, color .4s;
    text-align:center;text-shadow:0 2px 12px rgba(0,0,0,.45);}
  .ln.cur{opacity:1;color:#fff;font-size:calc(var(--vh)*5.6*var(--fs));}
  .ln.next{opacity:.6;}
  .plain .ln{opacity:.85;font-size:calc(var(--vh)*3.6*var(--fs));}
  .msg{position:absolute;left:0;right:0;top:45%;text-align:center;font-size:calc(var(--vh)*3.4);opacity:.75;z-index:2;}
  .src{position:absolute;right:calc(var(--vw)*2);bottom:calc(var(--vh)*1.2);font-size:calc(var(--vh)*1.5);opacity:.4;z-index:2;}
</style>
<div class="wrap">
  <div class="bg"></div><div class="glow"></div>
  <div class="bars">${bars}</div>
  <div class="head"><div class="art"></div><div><div class="title"></div><div class="artist"></div></div><div class="room"></div></div>
  <div class="lyr"><div class="track"></div></div>
  <div class="msg"></div>
  <div class="src">Lyrics: LRCLIB</div>
</div>`;
    const $ = s => this._root.querySelector(s);
    this._el = { wrap: $('.wrap'), bg: $('.bg'), glow: $('.glow'), art: $('.art'), title: $('.title'),
      artist: $('.artist'), room: $('.room'), lyr: $('.lyr'), track: $('.track'), msg: $('.msg') };
    this._applyColor();
    this._timer = setInterval(() => this._tick(), 250);
    this._observe();
  }

  _observe() {
    if (!window.ResizeObserver || this._ro) return;
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._el.wrap);
  }

  _resize() {
    const e = this._el, w = e.wrap.clientWidth, h = e.wrap.clientHeight;
    if (!w || !h) return;
    e.wrap.style.setProperty('--vw', w / 100 + 'px');
    e.wrap.style.setProperty('--vh', h / 100 + 'px');
    e.wrap.style.setProperty('--vmax', Math.max(w, h) / 100 + 'px');
    this._center();
  }

  disconnectedCallback() {
    clearInterval(this._timer); this._timer = null;
    clearTimeout(this._retry); this._retry = null;
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  connectedCallback() {
    if (!this._root) return;
    if (!this._timer) this._timer = setInterval(() => this._tick(), 250);
    this._observe();
  }

  _applyConfig() {
    const e = this._el, c = this._config, card = c.layout === 'card';
    e.wrap.classList.toggle('lite', c.visuals === 'lite');
    e.wrap.classList.toggle('off', c.visuals === 'off');
    e.wrap.classList.toggle('card', card);
    e.wrap.style.height = card ? String(c.height) : '100vh';
    e.wrap.style.setProperty('--fs', +c.font_scale || 1);
  }

  _renderMeta() {
    const e = this._el; if (!e) return;
    const st = this._st;
    if (!st) {
      e.title.textContent = 'Nothing playing'; e.artist.textContent = ''; e.room.textContent = '';
      e.art.style.backgroundImage = ''; e.track.innerHTML = ''; e.msg.textContent = 'Start some music to see lyrics';
      this._lines = null; this._plain = null; this._status = 'idle';
      return;
    }
    const a = st.attributes;
    e.title.textContent = a.media_title || '';
    e.artist.textContent = [a.media_artist, a.media_album_name].filter(Boolean).join(' · ');
    const fn = (a.friendly_name || '').trim(), w = fn.split(/\s+/), hlf = w.length / 2;
    e.room.textContent = (w.length % 2 === 0 && w.slice(0, hlf).join(' ') === w.slice(hlf).join(' ')) ? w.slice(0, hlf).join(' ') : fn;
    e.art.style.backgroundImage = a.entity_picture ? `url("${String(a.entity_picture).replace(/"/g, '%22')}")` : '';
  }

  _cacheGet(k) {
    try {
      const c = JSON.parse(sessionStorage.getItem(k));
      if (c && (c.data || Date.now() - c.at < LP_MISS_TTL)) return c;
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  _cacheSet(k, data) {
    try { sessionStorage.setItem(k, JSON.stringify({ at: Date.now(), data })); } catch (e) { /* storage full */ }
  }

  async _loadLyrics(a, attempt) {
    const key = this._key, tries = attempt || 0;
    clearTimeout(this._retry);
    this._lines = null; this._plain = null; this._status = 'loading';
    const e = this._el;
    e.track.innerHTML = ''; e.track.style.transform = 'translateY(0)';
    e.lyr.classList.remove('plain');
    e.msg.textContent = a.media_title ? 'Finding lyrics…' : '';
    if (!a.media_title) return;
    const dur = a.media_duration ? Math.round(a.media_duration) : 0;
    const cacheKey = ['lp2', a.media_title, a.media_artist, dur].join('|');
    const hit = this._cacheGet(cacheKey);
    let data = hit ? hit.data : null, failed = false;
    if (!hit) {
      const r = await lpFindLyrics(a.media_title, a.media_artist, dur);
      data = r.data; failed = r.failed;
      if (!failed) this._cacheSet(cacheKey, data);
    }
    if (key !== this._key) return;
    if (failed) {
      this._status = 'none';
      e.msg.textContent = 'Can’t reach LRCLIB right now';
      if (tries < LP_MAX_RETRIES) {
        this._retry = setTimeout(() => { if (key === this._key) this._loadLyrics(a, tries + 1); }, LP_RETRY_MS);
      }
      return;
    }
    const lines = data && data.syncedLyrics ? lpParseLrc(data.syncedLyrics) : [];
    if (lines.length) {
      if (lines[0].t > 3) lines.unshift({ t: 0, x: '♪' });
      this._lines = lines;
      e.track.innerHTML = lines.map(l => `<div class="ln">${this._esc(l.x || '♪')}</div>`).join('');
      e.msg.textContent = ''; this._status = 'synced';
    } else if (data && data.plainLyrics) {
      this._plain = data.plainLyrics;
      e.track.innerHTML = this._plain.split('\n').map(l => `<div class="ln">${this._esc(l) || '&nbsp;'}</div>`).join('');
      e.lyr.classList.add('plain'); e.msg.textContent = ''; this._status = 'plain';
    } else if (data && data.instrumental) {
      this._status = 'none'; e.msg.textContent = '♪ Instrumental ♪';
    } else {
      this._status = 'none'; e.msg.textContent = 'No lyrics found for this song';
    }
  }

  _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  _pos() {
    const st = this._st; if (!st) return 0;
    const a = st.attributes; let p = +a.media_position || 0;
    if (st.state === 'playing' && a.media_position_updated_at)
      p += (Date.now() - new Date(a.media_position_updated_at).getTime()) / 1000;
    return p + (+this._config.offset || 0);
  }

  _center() {
    const e = this._el, n = this._status === 'synced' && e.track.children[this._idx];
    if (!n) return;
    const y = n.offsetTop - e.lyr.clientHeight * 0.38 + n.offsetHeight / 2;
    e.track.style.transform = `translateY(${-Math.max(0, y)}px)`;
  }

  _tick() {
    const e = this._el; if (!e || !this._st) return;
    const playing = this._st.state === 'playing';
    e.wrap.classList.toggle('paused', !playing);
    if (this._status === 'plain' && playing && this._st.attributes.media_duration) {
      const frac = Math.min(1, this._pos() / this._st.attributes.media_duration);
      const max = Math.max(0, e.track.scrollHeight - e.lyr.clientHeight * 0.6);
      e.track.style.transform = `translateY(${-frac * max}px)`;
      return;
    }
    if (this._status !== 'synced' || !this._lines) return;
    const p = this._pos(); let i = 0;
    for (let k = 0; k < this._lines.length; k++) { if (this._lines[k].t <= p) i = k; else break; }
    if (i === this._idx) return;
    const nodes = e.track.children;
    if (nodes[this._idx]) nodes[this._idx].className = 'ln';
    if (nodes[this._idx + 1]) nodes[this._idx + 1].className = 'ln';
    this._idx = i;
    if (nodes[i]) nodes[i].className = 'ln cur';
    if (nodes[i + 1]) nodes[i + 1].className = 'ln next';
    this._center();
    e.wrap.classList.remove('pulse'); void e.wrap.offsetWidth; e.wrap.classList.add('pulse');
  }

  _loadColor(url) {
    if (!url) return;
    const img = new Image();
    this._colorImg = img;
    if (/^https?:/i.test(url) && !url.startsWith(location.origin)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (img !== this._colorImg) return;
      try {
        const c = document.createElement('canvas'); c.width = c.height = 24;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data; let r = 0, gg = 0, b = 0, n = 0, best = null, bs = -1;
        for (let k = 0; k < d.length; k += 4) {
          const R = d[k], G = d[k + 1], B = d[k + 2]; r += R; gg += G; b += B; n++;
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx - mn;
          if (sat > bs && mx > 60) { bs = sat; best = [R, G, B]; }
        }
        this._color = [r / n, gg / n, b / n].map(Math.round);
        this._accent = best || this._color;
        this._applyColor();
      } catch (e) { /* cross-origin art: keep previous colors */ }
    };
    img.src = url;
  }

  _applyColor() {
    const e = this._el; if (!e) return;
    const [r, g, b] = this._color, dark = `rgb(${r * .35 | 0},${g * .35 | 0},${b * .35 | 0})`;
    const [ar, ag, ab] = this._accent || [180, 120, 255];
    e.bg.style.background = `linear-gradient(160deg, ${dark} 0%, rgb(${r * .15 | 0},${g * .15 | 0},${b * .15 | 0}) 60%, #050505 100%)`;
    e.glow.style.background = `radial-gradient(circle, rgba(${ar},${ag},${ab},.55) 0%, rgba(${ar},${ag},${ab},0) 65%)`;
    e.wrap.style.setProperty('--accent', `linear-gradient(to top, rgba(${ar},${ag},${ab},.95), rgba(255,255,255,.6))`);
  }

  getCardSize() { return this._config && this._config.layout === 'card' ? 9 : 12; }
}

LyricsPartyCard.helpers = { clean: lpClean, artists: lpArtists, parseLrc: lpParseLrc, pick: lpPick, findLyrics: lpFindLyrics };

const LP_LABELS = {
  entity: 'Media player (leave empty to follow whatever is playing)',
  entities: 'Players to follow (optional)',
  layout: 'Layout',
  height: 'Card height (card layout only)',
  visuals: 'Visuals',
  offset: 'Lyrics offset',
  font_scale: 'Lyrics size'
};

const LP_SCHEMA = [
  { name: 'entity', selector: { entity: { domain: 'media_player' } } },
  { name: 'entities', selector: { entity: { domain: 'media_player', multiple: true } } },
  { name: 'layout', selector: { select: { mode: 'dropdown', options: [
    { value: 'card', label: 'Card' }, { value: 'fullscreen', label: 'Full screen (panel view)' }] } } },
  { name: 'height', selector: { text: {} } },
  { name: 'visuals', selector: { select: { mode: 'dropdown', options: [
    { value: 'full', label: 'Full' }, { value: 'lite', label: 'Lite (slower devices)' }, { value: 'off', label: 'Off' }] } } },
  { name: 'offset', selector: { number: { min: -5, max: 5, step: 0.1, mode: 'box', unit_of_measurement: 's' } } },
  { name: 'font_scale', selector: { number: { min: 0.6, max: 2, step: 0.1, mode: 'slider' } } }
];

class LyricsPartyCardEditor extends HTMLElement {
  setConfig(config) { this._config = config; this._update(); }
  set hass(hass) { this._hass = hass; this._update(); }

  _update() {
    if (!this._config) return;
    if (!this._form) {
      this._form = document.createElement('ha-form');
      this._form.schema = LP_SCHEMA;
      this._form.computeLabel = s => LP_LABELS[s.name] || s.name;
      this._form.addEventListener('value-changed', ev => {
        ev.stopPropagation();
        const config = Object.assign({ type: this._config.type }, ev.detail.value);
        ['entity', 'height'].forEach(k => { if (!config[k]) delete config[k]; });
        if (!config.entities || !config.entities.length) delete config.entities;
        this._config = config;
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = Object.assign({ layout: 'fullscreen', visuals: 'full', offset: 0.3, font_scale: 1 }, this._config);
  }
}

customElements.define('lyrics-party-card', LyricsPartyCard);
customElements.define('lyrics-party-card-editor', LyricsPartyCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'lyrics-party-card', name: 'Lyrics Party', description: 'Time-synced lyrics and party visuals for the playing media player', preview: false });
console.info('%c LYRICS-PARTY-CARD %c ' + LP_VERSION, 'background:#7c3aed;color:#fff', '');
