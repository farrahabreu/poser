'use strict';

/**
 * mediaSearch.js — unified search across TMDB, MusicBrainz, and OpenLibrary.
 * Fashion entries are manual (no external API).
 *
 * All functions return a normalised array of result objects:
 * {
 *   external_id : string   — canonical ID from the source API
 *   media_type  : string   — movie | tv | song | album | artist | book | graphic_novel | show | collection | campaign | designer
 *   title       : string
 *   creator     : string | null
 *   year        : number | null
 *   cover_url   : string | null
 * }
 */

const TMDB_BASE  = 'https://api.themoviedb.org/3';
const TMDB_IMG   = 'https://image.tmdb.org/t/p/w342';
const MB_BASE    = 'https://musicbrainz.org/ws/2';
const OL_BASE    = 'https://openlibrary.org';

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'POSER/1.0 (poser.app)',
      ...headers,
    },
  });
  if (!res.ok) throw Object.assign(new Error(`Upstream ${res.status}`), { status: res.status });
  return res.json();
}

function tmdbYear(dateStr) {
  return dateStr ? parseInt(dateStr.slice(0, 4), 10) : null;
}

// ── TMDB ─────────────────────────────────────────────────────────────────────

async function searchCinema(query, page = 1) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return [];

  const data = await fetchJSON(
    `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}&page=${page}&include_adult=false`,
    { Authorization: `Bearer ${key}` }
  );

  return (data.results || [])
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .map(r => ({
      external_id: String(r.id),
      media_type:  r.media_type,        // 'movie' | 'tv'
      title:       r.title || r.name,
      creator:     null,                // filled on detail fetch if needed
      year:        tmdbYear(r.release_date || r.first_air_date),
      cover_url:   r.poster_path ? TMDB_IMG + r.poster_path : null,
    }));
}

// ── MusicBrainz ──────────────────────────────────────────────────────────────

async function searchMusic(query, type = 'recording') {
  // type: recording | release | artist
  const validTypes = ['recording', 'release', 'release-group', 'artist'];
  if (!validTypes.includes(type)) type = 'recording';

  const data = await fetchJSON(
    `${MB_BASE}/${type}?query=${encodeURIComponent(query)}&limit=20&fmt=json`
  );

  const list =
    data.recordings  ||
    data.releases    ||
    data['release-groups'] ||
    data.artists     || [];

  return list.map(r => {
    const artistCredit = (r['artist-credit'] || []).map(ac => ac.name || ac.artist?.name).join(', ');
    const releaseDate  = r.date || r['first-release-date'] || null;
    const year         = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;

    let mediaType = 'song';
    if (type === 'release')        mediaType = 'album';
    if (type === 'release-group')  mediaType = 'album';
    if (type === 'artist')         mediaType = 'artist';

    return {
      external_id: r.id,                        // MBID
      media_type:  mediaType,
      title:       r.title || r.name,
      creator:     artistCredit || null,
      year,
      cover_url:   null,                         // MB has no artwork in search; use CAA separately
    };
  });
}

// ── OpenLibrary ──────────────────────────────────────────────────────────────

async function searchLiterature(query) {
  const data = await fetchJSON(
    `${OL_BASE}/search.json?q=${encodeURIComponent(query)}&limit=20&fields=key,title,author_name,first_publish_year,cover_i,subject`
  );

  return (data.docs || []).map(doc => {
    const coverId = doc.cover_i;
    return {
      external_id: doc.key,                           // e.g. /works/OL45804W
      media_type:  detectLitType(doc.subject),
      title:       doc.title,
      creator:     doc.author_name ? doc.author_name.join(', ') : null,
      year:        doc.first_publish_year || null,
      cover_url:   coverId
        ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`
        : null,
    };
  });
}

function detectLitType(subjects) {
  if (!subjects || !subjects.length) return 'book';
  const haystack = subjects.join(' ').toLowerCase();
  if (haystack.includes('graphic novel') || haystack.includes('comics')) return 'graphic_novel';
  if (haystack.includes('poetry') || haystack.includes('poems'))         return 'poetry';
  if (haystack.includes('essay'))                                         return 'essay';
  return 'book';
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * @param {'cinema'|'music'|'fashion'|'lit'} pillar
 * @param {string} query
 * @param {object} opts  — { musicType?: 'recording'|'release'|'release-group'|'artist' }
 */
async function search(pillar, query, opts = {}) {
  if (!query || !query.trim()) return [];

  switch (pillar) {
    case 'cinema':  return searchCinema(query);
    case 'music':   return searchMusic(query, opts.musicType || 'recording');
    case 'lit':     return searchLiterature(query);
    case 'fashion': return [];  // manual entry only
    default:        return [];
  }
}

module.exports = { search, searchCinema, searchMusic, searchLiterature };
