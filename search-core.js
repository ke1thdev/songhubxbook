/** Normalize once for indexing; searches tolerate case, accents and punctuation. */
export function normalize(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const clock = () => performance.now();
const safeInteger = (value, fallback, max) => Number.isFinite(value)
  ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
const row = (song) => ({ code: song.code, title: song.title, artist: song.artist });

/**
 * A compact trigram posting list narrows substring searches before matching.
 * Short searches scan cached strings, away from the UI in the Web Worker.
 * Inputs are already alphabetically sorted by the deterministic data build.
 */
export function createSearchEngine(tuples) {
  if (!Array.isArray(tuples)) throw new TypeError('The song catalog is invalid.');
  const byCode = new Map();
  const songs = tuples.map((tuple, index) => {
    if (!Array.isArray(tuple) || tuple.length !== 3 || !/^\d{6}$/.test(tuple[0])
      || typeof tuple[1] !== 'string' || typeof tuple[2] !== 'string' || byCode.has(tuple[0])) {
      throw new TypeError('The song catalog contains an invalid entry.');
    }
    byCode.set(tuple[0], index);
    const [code, title, artist] = tuple;
    const titleKey = normalize(title);
    const artistKey = normalize(artist);
    return { code, title, artist, titleKey, artistKey, searchKey: `${code} ${titleKey} ${artistKey}` };
  });

  const postings = new Map();
  for (let id = 0; id < songs.length; id += 1) {
    const text = songs[id].searchKey;
    const grams = new Set();
    for (let i = 0; i <= text.length - 3; i += 1) {
      const gram = text.slice(i, i + 3);
      // Queries are split into words; space-spanning grams never help them.
      if (gram.includes(' ') || grams.has(gram)) continue;
      grams.add(gram);
      const list = postings.get(gram);
      if (list) list.push(id);
      else postings.set(gram, [id]);
    }
  }
  let postingEntries = 0;
  for (const [gram, ids] of postings) {
    postingEntries += ids.length;
    postings.set(gram, Uint32Array.from(ids));
  }
  const allIds = Uint32Array.from({ length: songs.length }, (_, id) => id);

  function search({ query = '', view = 'all', favorites = [], offset = 0, limit = 60 } = {}) {
    const start = clock();
    const key = normalize(query);
    const tokens = [...new Set(key.split(' ').filter(Boolean))];
    const pageOffset = safeInteger(offset, 0, songs.length);
    const pageLimit = Math.max(1, safeInteger(limit, 60, 200));
    let favoriteIds;
    if (view === 'favorites') {
      favoriteIds = new Set();
      if (Array.isArray(favorites)) {
        for (const code of favorites) {
          const id = byCode.get(code);
          if (id !== undefined) favoriteIds.add(id);
        }
      }
    }

    // Browsing needs no scoring or scanning: the catalog is already ordered.
    if (!key) {
      const ids = favoriteIds ? [...favoriteIds].sort((a, b) => a - b) : allIds;
      return {
        rows: Array.from(ids.slice(pageOffset, pageOffset + pageLimit), (id) => row(songs[id])),
        count: ids.length,
        offset: pageOffset,
        elapsedMs: +(clock() - start).toFixed(2),
      };
    }

    let candidates = allIds;
    for (const token of tokens) {
      for (let i = 0; i <= token.length - 3; i += 1) {
        const list = postings.get(token.slice(i, i + 3));
        if (!list) {
          return { rows: [], count: 0, offset: pageOffset, elapsedMs: +(clock() - start).toFixed(2) };
        }
        if (list.length < candidates.length) candidates = list;
      }
    }
    // A small favorites collection is itself a better candidate index.
    if (favoriteIds && favoriteIds.size < candidates.length) {
      candidates = [...favoriteIds].sort((a, b) => a - b);
    }

    const buckets = [[], [], [], [], [], [], []];
    const numericCode = /^\d{1,6}$/.test(key) ? key.padStart(6, '0') : null;
    let count = 0;
    candidate: for (const id of candidates) {
      if (favoriteIds && !favoriteIds.has(id)) continue;
      const song = songs[id];
      for (const token of tokens) {
        if (!song.searchKey.includes(token)) continue candidate;
      }
      let rank = 6;
      if (!key) rank = 0;
      else if (song.code === key || song.code === numericCode) rank = 0;
      else if (song.titleKey === key) rank = 1;
      else if (song.titleKey.startsWith(key)) rank = 2;
      else if (song.titleKey.includes(key)) rank = 3;
      else if (tokens.every((token) => song.titleKey.includes(token))) rank = 4;
      else if (song.artistKey === key || song.artistKey.startsWith(key)) rank = 5;
      buckets[rank].push(id);
      count += 1;
    }

    const rows = [];
    let skip = pageOffset;
    for (const bucket of buckets) {
      if (skip >= bucket.length) { skip -= bucket.length; continue; }
      for (let i = skip; i < bucket.length && rows.length < pageLimit; i += 1) {
        rows.push(row(songs[bucket[i]]));
      }
      skip = 0;
      if (rows.length === pageLimit) break;
    }
    return { rows, count, offset: pageOffset, elapsedMs: +(clock() - start).toFixed(2) };
  }

  return {
    search,
    total: songs.length,
    stats: { songs: songs.length, trigrams: postings.size, postingEntries, postingBytes: postingEntries * 4 },
  };
}
