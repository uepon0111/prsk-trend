// scripts/fetch_youtube.js
// 実行方法（Actions 内で）： node scripts/fetch_youtube.js
// 必要：環境変数 YOUTUBE_API_KEY（GitHub Secrets に入れる）
// 入力ファイル： videos_list.json
// 出力ファイル： data/videos.json （存在しなければ作る）
// 動作：各動画の snippet/statistics を取得し、日次の history を追記する

const fs = require('fs').promises;
const path = require('path');

const API_KEY = process.env.YOUTUBE_API_KEY;
if(!API_KEY){
  console.error('Error: YOUTUBE_API_KEY が設定されていません。GitHub Secrets を確認してください。');
  process.exit(1);
}

const LIST_PATH = path.resolve(process.cwd(), 'videos_list.json');
const OUT_DIR = path.resolve(process.cwd(), 'data');
const OUT_PATH = path.join(OUT_DIR, 'videos.json');

async function fetchJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
  return await res.json();
}

function todayStr(){
  const d = new Date();
  return d.toISOString().slice(0,10);
}

// safe: keep history length reasonable (e.g., last 400 days)
function trimHistory(history, max=400){
  if(history.length <= max) return history;
  return history.slice(history.length - max);
}

(async ()=>{
  try{
    console.log('読み込み: videos_list.json');
    const raw = await fs.readFile(LIST_PATH, 'utf8');
    const list = JSON.parse(raw).videos || [];
    if(!Array.isArray(list) || list.length === 0){
      console.error('videos_list.json が空です。');
      process.exit(1);
    }

    // 出力フォルダ作成
    await fs.mkdir(OUT_DIR, {recursive:true});

    // 既存データ読み込み（あれば）
    let existing = { videos: [], updated_at: null };
    try{
      const old = await fs.readFile(OUT_PATH, 'utf8');
      existing = JSON.parse(old);
    }catch(e){
      console.log('既存の data/videos.json が見つかりません。新規作成します。');
    }

    // map existing by videoId for quick update
    const existingMap = new Map();
    (existing.videos || []).forEach(v=>{
      if(v.videoId) existingMap.set(v.videoId, v);
    });

    // バッチで複数IDを一度に問い合わせる（API は最大 50）
    const batchSize = 50;
    const results = [];

    for(let i=0;i<list.length;i+=batchSize){
      const chunk = list.slice(i, i+batchSize);
      const ids = chunk.map(x=>x.videoId).join(',');
      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${API_KEY}`;
      console.log('Fetching', ids);
      const json = await fetchJson(url);
      const items = json.items || [];
      // build map from id -> item
      const itemMap = new Map();
      items.forEach(it => itemMap.set(it.id, it));
      // for each requested id, create record (even if not returned)
      for(const meta of chunk){
        const id = meta.videoId;
        const item = itemMap.get(id);
        const title = item ? item.snippet.title : (existingMap.get(id)?.title || 'Unknown title');
        const thumbnail = item ? (item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url) : (existingMap.get(id)?.thumbnail || '');
        const published = item ? (item.snippet.publishedAt ? item.snippet.publishedAt.slice(0,10) : '') : (existingMap.get(id)?.published || '');
        const views = item ? parseInt(item.statistics?.viewCount || 0, 10) : (existingMap.get(id)?.history?.slice(-1)[0]?.views || 0);
        const urlWatch = `https://youtu.be/${id}`;

        // existing history
        const prev = existingMap.get(id);
        let history = prev && Array.isArray(prev.history) ? prev.history.slice() : [];
        const today = todayStr();
        // append today's views if not already present or if changed
        if(history.length === 0 || history[history.length-1].date !== today){
          history.push({date: today, views: views});
        } else {
          // update last record if views increased (safe)
          history[history.length-1].views = views;
        }
        history = trimHistory(history, 500);

        results.push({
          videoId: id,
          url: urlWatch,
          title,
          thumbnail,
          published,
          banner: meta.banner || (prev && prev.banner) || '',
          unit: meta.unit || (prev && prev.unit) || '',
          history
        });
      }
    }

    const out = { updated_at: (new Date()).toISOString(), videos: results };
    await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), 'utf8');
    console.log('更新完了: data/videos.json を書き出しました。');
  }catch(err){
    console.error('Error:', err);
    process.exit(1);
  }
})();
