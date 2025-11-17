// scripts/fetch_youtube.js
// - Node 18 前提 (Actions の setup-node で node-version: '18' を使ってください)
// - 必須: 環境変数 YOUTUBE_API_KEY を GitHub Actions Secrets に設定
// - 入力: videos_list.json (各エントリに url, banner, unit)
// - 出力: data/videos.json (各動画に videoId, url, title, thumbnail, published, banner, unit, history の配列)
// - 履歴は { datetime: "2025-11-17T12:30:00.000Z", views: 12345 } の形で保存（30分刻み）

const fs = require('fs').promises;
const path = require('path');

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Error: YOUTUBE_API_KEY が設定されていません。GitHub Secrets を確認してください。');
  process.exit(1);
}

const LIST_PATH = path.resolve(process.cwd(), 'videos_list.json');
const OUT_DIR = path.resolve(process.cwd(), 'data');
const OUT_PATH = path.join(OUT_DIR, 'videos.json');
const RESET_MARKER = path.join(OUT_DIR, '.reset_done');

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
  return await res.json();
}

function nowRoundedTo30MinISO(date = new Date()) {
  const d = new Date(date);
  const m = d.getUTCMinutes();
  if (m >= 30) d.setUTCMinutes(30);
  else d.setUTCMinutes(0);
  d.setUTCSeconds(0);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}

function parseHistoryEntryDatetime(e) {
  // Accept either { datetime: "..."} or { date: "YYYY-MM-DD" } (legacy)
  if (!e) return null;
  if (e.datetime) return new Date(e.datetime);
  if (e.date) {
    // treat as midnight UTC to preserve existing
    return new Date(e.date + 'T00:00:00.000Z');
  }
  return null;
}

function isoFromEntry(e) {
  if (!e) return null;
  if (e.datetime) return e.datetime;
  if (e.date) return e.date + 'T00:00:00.000Z';
  return null;
}

function trimHistory(history, max = 5000) {
  if (!Array.isArray(history)) return [];
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

// URL から YouTube の videoId を抽出するユーティリティ（ショート URL / watch?v= / shorts / embed 対応）
function extractVideoIdFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();

    if (host === 'youtu.be') {
      const p = url.pathname.split('/').filter(Boolean);
      return p[0] || null;
    }

    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const p = url.pathname.split('/').filter(Boolean);
      if (url.searchParams && url.searchParams.get('v')) return url.searchParams.get('v');
      if (p[0] === 'shorts' && p[1]) return p[1];
      if (p[0] === 'embed' && p[1]) return p[1];
      if (p[0] === 'v' && p[1]) return p[1];
    }

    // fallback: match typical 11-char id
    const m = urlStr.match(/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return null;
  } catch (e) {
    return null;
  }
}

(function isoNow() {
  // noop placeholder for linter friendliness
})();

(async () => {
  try {
    console.log('読み込み: videos_list.json');
    const raw = await fs.readFile(LIST_PATH, 'utf8');
    const listJson = JSON.parse(raw);
    const list = Array.isArray(listJson.videos) ? listJson.videos : [];
    if (!list.length) {
      console.error('videos_list.json に動画が登録されていません。');
      process.exit(1);
    }

    await fs.mkdir(OUT_DIR, { recursive: true });

    // 既存の data/videos.json があれば読み込んで履歴を引き継ぐ
    let existing = { videos: [], updated_at: null };
    try {
      const old = await fs.readFile(OUT_PATH, 'utf8');
      existing = JSON.parse(old);
    } catch (e) {
      console.log('既存の data/videos.json が見つかりません。新規作成します。');
    }
    const existingMap = new Map();
    (existing.videos || []).forEach(v => {
      if (v.videoId) existingMap.set(v.videoId, v);
    });

    // Determine whether we should perform a one-time reset.
    let isResetNeeded = false;
    try {
      await fs.stat(RESET_MARKER);
      isResetNeeded = false;
    } catch (e) {
      // marker not found -> reset will be performed once and marker will be created
      isResetNeeded = true;
    }
    if (isResetNeeded) {
      console.log('*** data/videos.json を一度リセットします（.reset_done を作成します） ***');
    }

    // entries: [{ videoId, url, banner, unit }, ...]
    const entries = [];
    for (const meta of list) {
      const url = meta.url;
      const vid = extractVideoIdFromUrl(url);
      if (!vid) {
        console.warn(`警告: URL から動画IDを抽出できませんでした。スキップします: ${url}`);
        continue;
      }
      entries.push({ videoId: vid, url, banner: meta.banner || '', unit: meta.unit || '' });
    }

    if (entries.length === 0) {
      console.error('有効な動画が1つも見つかりませんでした。videos_list.json を確認してください。');
      process.exit(1);
    }

    // fetch in batches (max 50)
    const batchSize = 50;
    const results = [];

    // current rounded datetime in ISO (UTC) to use as key (30-min rounded)
    const currentRounded = nowRoundedTo30MinISO(new Date());

    for (let i = 0; i < entries.length; i += batchSize) {
      const chunk = entries.slice(i, i + batchSize);
      const ids = chunk.map(x => x.videoId).join(',');
      const urlApi = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${API_KEY}`;
      console.log('Fetching IDs:', ids);
      let json;
      try {
        json = await fetchJson(urlApi);
      } catch (err) {
        console.error('YouTube API 取得エラー:', err.message);
        // on error: fallback to existing data for this chunk
        for (const meta of chunk) {
          const prev = existingMap.get(meta.videoId);
          const prevHistory = prev && prev.history ? prev.history.slice() : [];
          results.push({
            videoId: meta.videoId,
            url: meta.url,
            title: prev?.title || 'Unknown title',
            thumbnail: prev?.thumbnail || '',
            published: prev?.published || '',
            banner: meta.banner || prev?.banner || '',
            unit: meta.unit || prev?.unit || '',
            history: trimHistory(prevHistory)
          });
        }
        continue;
      }

      const items = Array.isArray(json.items) ? json.items : [];
      const itemMap = new Map();
      items.forEach(it => itemMap.set(it.id, it));

      for (const meta of chunk) {
        const id = meta.videoId;
        const item = itemMap.get(id);

        const title = item ? (item.snippet?.title || '') : (existingMap.get(id)?.title || '');
        const thumbnail = item ? (item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '') : (existingMap.get(id)?.thumbnail || '');
        const published = item ? (item.snippet?.publishedAt ? item.snippet.publishedAt.slice(0, 10) : '') : (existingMap.get(id)?.published || '');
        const views = item ? parseInt(item.statistics?.viewCount || 0, 10) : (existingMap.get(id)?.history?.slice(-1)[0]?.views || 0);
        const prev = existingMap.get(id);
        let history = prev && Array.isArray(prev.history) ? prev.history.slice() : [];

        if (isResetNeeded) {
          // One-time reset: discard previous history and keep only the current snapshot
          history = [{ datetime: currentRounded, views: views }];
        } else {
          // normalize legacy 'date' entries by keeping them but not altering
          // Check last entry datetime (either datetime or date)
          let lastEntry = history.length ? history[history.length - 1] : null;
          let lastIso = lastEntry ? isoFromEntry(lastEntry) : null;

          if (!lastIso) {
            // no previous history -> push new rounded entry
            history.push({ datetime: currentRounded, views: views });
          } else {
            // compare rounded iso strings: if last entry is at same rounded time, update; otherwise push
            // convert lastIso to Date and round to 30min to be safe
            let lastDate = new Date(lastIso);
            // round lastDate to 30min
            const roundedLast = nowRoundedTo30MinISO(lastDate);
            if (roundedLast === currentRounded) {
              // update last entry's views (works for both datetime and date legacy, we modify to datetime)
              history[history.length - 1] = { datetime: currentRounded, views: views };
            } else {
              history.push({ datetime: currentRounded, views: views });
            }
          }
        }

        history = trimHistory(history, 5000);

        results.push({
          videoId: id,
          url: meta.url,
          title,
          thumbnail,
          published,
          banner: meta.banner || (prev && prev.banner) || '',
          unit: meta.unit || (prev && prev.unit) || '',
          history
        });
      }
    }

    const out = { updated_at: new Date().toISOString(), videos: results };
    await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
    console.log('更新完了: data/videos.json を書き出しました。');

    if (isResetNeeded) {
      try {
        await fs.writeFile(RESET_MARKER, new Date().toISOString(), 'utf8');
        console.log('.reset_done を作成しました。次回以降は履歴の一括リセットは行われません。');
      } catch (e) {
        console.warn('注意: .reset_done の作成に失敗しました。', e.message);
      }
    }
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
