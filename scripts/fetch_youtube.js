// scripts/fetch_youtube.js
// - GitHub Actions から node 18 で実行することを想定
// - 必須: 環境変数 YOUTUBE_API_KEY を GitHub Secrets に設定
// - 入力: videos_list.json (各エントリに url, banner, unit)
// - 出力: data/videos.json (各動画に videoId, url, title, thumbnail, published, banner, unit, history の配列)

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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
  return await res.json();
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function trimHistory(history, max = 500) {
  if (!Array.isArray(history)) return [];
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

// URL から YouTube の videoId を抽出するユーティリティ
function extractVideoIdFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    // ensure it has protocol
    if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();

    // youtu.be short link
    if (host === 'youtu.be') {
      const p = url.pathname.split('/').filter(Boolean);
      return p[0] || null;
    }

    // youtube domains
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const p = url.pathname.split('/').filter(Boolean);
      // watch?v=ID
      if (url.searchParams && url.searchParams.get('v')) return url.searchParams.get('v');
      // shorts/ID
      if (p[0] === 'shorts' && p[1]) return p[1];
      // embed/ID
      if (p[0] === 'embed' && p[1]) return p[1];
      // v/ID
      if (p[0] === 'v' && p[1]) return p[1];
    }

    // fallback: attempt to match typical 11-char id in the URL using regex
    const m = urlStr.match(/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];

    return null;
  } catch (e) {
    return null;
  }
}

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

    // videos_list の各 entry から videoId を抽出して配列化
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

    // YouTube API は一度に最大50個の id を指定可 -> バッチ処理
    const batchSize = 50;
    const results = [];

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
        // エラー時は既存データを可能な限り返す（安全に続行）
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

        const today = todayStr();
        if (history.length === 0 || history[history.length - 1].date !== today) {
          history.push({ date: today, views: views });
        } else {
          history[history.length - 1].views = views;
        }
        history = trimHistory(history, 500);

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

  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
