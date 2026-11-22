const WORKER_BASE = 'https://amphoreus.ejpoacc.workers.dev';
const SF_SYMBOL_BASE = 'https://raw.githubusercontent.com/brendanballon/sfsymbols-svg/master/symbols';

const state = {
  query: '',
  storefront: 'us',
  activeNav: 'albums', // 'albums' | 'artists' | 'playlists'
  viewMode: 'search', // 'search' | 'album' | 'artist' | 'playlist'
  selectedId: null,
  selectedData: null,
  history: [],
  searchResults: {
    albums: [],
    artists: [],
    songs: [],
    playlists: [],
    musicVideos: []
  },
  playingTrackId: null
};

const symbolCache = new Map();
const activeHlsInstances = [];

const dom = {
  sidebar: document.getElementById('sidebar'),
  mobileNavToggle: document.getElementById('mobileNavToggle'),
  sidebarSearchForm: document.getElementById('sidebarSearchForm'),
  sidebarSearchInput: document.getElementById('sidebarSearchInput'),
  storefrontInput: document.getElementById('storefrontInput'),
  brandResetBtn: document.getElementById('brandResetBtn'),
  navItems: Array.from(document.querySelectorAll('.nav-item')),
  contentArea: document.getElementById('contentArea'),
  mediaModal: document.getElementById('mediaModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalSubtitle: document.getElementById('modalSubtitle'),
  modalBody: document.getElementById('modalBody'),
  modalCloseBtn: document.getElementById('modalCloseBtn'),
  toastBanner: document.getElementById('toastBanner'),
  previewAudio: document.getElementById('previewAudio')
};

function snapshotRoute() {
  return {
    viewMode: state.viewMode,
    selectedId: state.selectedId,
    activeNav: state.activeNav,
    query: state.query
  };
}

function pushHistory() {
  const snap = snapshotRoute();
  const prev = state.history[state.history.length - 1];
  if (
    !prev ||
    prev.viewMode !== snap.viewMode ||
    prev.selectedId !== snap.selectedId ||
    prev.activeNav !== snap.activeNav ||
    prev.query !== snap.query
  ) {
    state.history.push(snap);
  }
}

async function goBack() {
  const prev = state.history.pop();
  if (!prev) return;
  state.activeNav = prev.activeNav;
  syncNavActiveState();
  if (prev.viewMode === 'album' && prev.selectedId) {
    await openAlbumDetail(prev.selectedId, { recordHistory: false });
  } else if (prev.viewMode === 'artist' && prev.selectedId) {
    await openArtistDetail(prev.selectedId, { recordHistory: false });
  } else if (prev.viewMode === 'playlist' && prev.selectedId) {
    await openPlaylistDetail(prev.selectedId, { recordHistory: false });
  } else {
    state.viewMode = 'search';
    state.selectedId = null;
    state.selectedData = null;
    renderSearchView();
  }
}

function syncNavActiveState() {
  dom.navItems.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.nav === state.activeNav);
  });
}

/* ==========================================================================
   SF Symbols Loader (strips bounding outlines & renders in white/currentColor)
   ========================================================================== */
async function loadSfSymbolSvg(name) {
  if (symbolCache.has(name)) {
    return symbolCache.get(name);
  }

  const url = `${SF_SYMBOL_BASE}/${encodeURIComponent(name)}.svg`;
  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rawText = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawText, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (!svg) return null;

      const preferredLayer =
        svg.querySelector('#Regular-S') ||
        svg.querySelector('[id*="Regular-S"]') ||
        svg.querySelector('#Medium-S') ||
        svg.querySelector('[id*="Medium-S"]');

      if (preferredLayer) {
        const wrapper = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
        const cloned = preferredLayer.cloneNode(true);
        cloned.removeAttribute('transform');
        wrapper.appendChild(cloned);
        svg.innerHTML = '';
        svg.appendChild(wrapper);
      }

      svg.querySelectorAll('rect, line, #Notes, #Guides, [id*="Notes"], [id*="Guides"]').forEach((el) => {
        el.remove();
      });

      svg.querySelectorAll('*').forEach((el) => {
        el.removeAttribute('stroke');
        el.removeAttribute('stroke-width');
        if (el.tagName.toLowerCase() !== 'g' && el.tagName.toLowerCase() !== 'svg') {
          el.setAttribute('fill', 'currentColor');
        }
      });

      svg.removeAttribute('width');
      svg.removeAttribute('height');
      if (!svg.getAttribute('viewBox')) {
        svg.setAttribute('viewBox', '0 0 28 28');
      }

      return svg.outerHTML;
    } catch {
      return null;
    }
  })();

  symbolCache.set(name, promise);
  return promise;
}

async function hydrateSfSymbols(root = document) {
  const placeholders = Array.from(root.querySelectorAll('[data-sf-symbol]'));
  await Promise.all(
    placeholders.map(async (el) => {
      const symbolName = el.getAttribute('data-sf-symbol');
      if (!symbolName) return;
      const svgMarkup = await loadSfSymbolSvg(symbolName);
      if (svgMarkup) {
        el.innerHTML = svgMarkup;
      }
    })
  );
}

/* ==========================================================================
   Helpers: Formatting, Safe Editorial HTML, Clipboard, Audio Preview & HLS
   ========================================================================== */
function formatArtworkUrl(rawUrl, width = 600, height = 600) {
  if (!rawUrl) return '';
  return rawUrl.replace('{w}', String(width)).replace('{h}', String(height));
}

function formatDuration(ms) {
  if (!ms || Number.isNaN(ms)) return '';
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatTotalMinutes(tracks) {
  const totalMs = (tracks || []).reduce((acc, t) => acc + (t.attributes?.durationInMillis || 0), 0);
  return Math.max(1, Math.round(totalMs / 60000));
}

function escapeHtml(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function stripHtmlTags(str = '') {
  return String(str).replace(/<[^>]*>/g, '');
}

/**
 * Safely renders Apple Music editorialNotes strings that contain <b>, <strong>, <i>, <em>, <br>
 * while escaping any unsafe tags or event handlers.
 */
function formatEditorialHtml(rawHtml = '') {
  if (!rawHtml) return '';
  const safe = String(rawHtml)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(b|strong|i|em|br)\s*\/?>/gi, (match) => `@@TAG:${match.toLowerCase()}@@`)
    .replace(/<[^>]*>/g, '');

  const escaped = escapeHtml(safe);
  return escaped.replace(/@@TAG:(<\/?(?:b|strong|i|em|br)\s*\/?>)@@/g, (_, tag) => {
    if (tag.startsWith('<br')) return '<br>';
    return tag;
  });
}

let toastTimer = null;
function showToast(message) {
  dom.toastBanner.textContent = message;
  dom.toastBanner.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toastBanner.classList.remove('is-visible');
  }, 1900);
}

async function copyToClipboard(text, label = 'Copied to clipboard') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
  }
  showToast(label);
}

function toggleTrackPreview(trackId, previewUrl, rowEl) {
  if (!previewUrl) {
    showToast('No preview available for this track');
    return;
  }

  if (state.playingTrackId === trackId && !dom.previewAudio.paused) {
    dom.previewAudio.pause();
    state.playingTrackId = null;
    document.querySelectorAll('.track-row.is-playing, .top-tile.is-playing').forEach((r) => r.classList.remove('is-playing'));
    return;
  }

  document.querySelectorAll('.track-row.is-playing, .top-tile.is-playing').forEach((r) => r.classList.remove('is-playing'));
  dom.previewAudio.src = previewUrl;
  dom.previewAudio.play().catch(() => showToast('Unable to play preview'));
  state.playingTrackId = trackId;
  if (rowEl) rowEl.classList.add('is-playing');
}

dom.previewAudio.addEventListener('ended', () => {
  state.playingTrackId = null;
  document.querySelectorAll('.track-row.is-playing, .top-tile.is-playing').forEach((r) => r.classList.remove('is-playing'));
});

function toMp4Url(url) {
  if (!url) return '';
  return url.replace(/\.m3u8(\?.*)?$/, '-.mp4');
}

function parseM3U8(content) {
  const streams = [];
  const lines = content.split('
');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.substring(18);
      const resMatch = attrs.match(/RESOLUTION=([0-9x]+)/);
      const bwMatch = attrs.match(/BANDWIDTH=([0-9]+)/);
      const codecsMatch = attrs.match(/CODECS="([^"]+)"/);
      const nextUrl = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1].trim() : '';
      if (nextUrl) {
        streams.push({
          resolution: resMatch ? resMatch[1] : 'Stream',
          bandwidthNum: bwMatch ? parseInt(bwMatch[1], 10) : 0,
          codecs: codecsMatch ? codecsMatch[1] : '',
          url: nextUrl
        });
      }
    }
  }
  return streams;
}

function pickBestStream(streams, exactRes) {
  const matches = streams.filter((s) => s.resolution === exactRes);
  if (!matches.length) return null;
  matches.sort((a, b) => b.bandwidthNum - a.bandwidthNum);
  return toMp4Url(matches[0].url);
}

function cleanupHlsPlayers() {
  while (activeHlsInstances.length) {
    const inst = activeHlsInstances.pop();
    try {
      inst.destroy();
    } catch {
      // ignore
    }
  }
}

function attachHlsToVideo(videoEl, playUrl) {
  if (!videoEl || !playUrl) return;
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ maxBufferLength: 5, maxMaxBufferLength: 10 });
    hls.loadSource(playUrl);
    hls.attachMedia(videoEl);
    activeHlsInstances.push(hls);
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = playUrl;
  } else {
    videoEl.src = playUrl;
  }
}

/* ==========================================================================
   AMP-API Requests via Cloudflare Worker
   ========================================================================== */
async function fetchCatalogSearch(term, storefront = 'us') {
  const types = 'albums,artists,songs,playlists,music-videos';
  const url = `${WORKER_BASE}/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(term)}&types=${types}&extend=editorialVideo,editorialNotes&limit=12`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Catalog search failed (${res.status})`);
  const json = await res.json();
  const r = json.results || {};
  return {
    albums: r.albums?.data || [],
    artists: r.artists?.data || [],
    songs: r.songs?.data || [],
    playlists: r.playlists?.data || [],
    musicVideos: r['music-videos']?.data || []
  };
}

async function fetchAlbumDetail(albumId, storefront = 'us') {
  const url = `${WORKER_BASE}/v1/catalog/${encodeURIComponent(storefront)}/albums/${encodeURIComponent(albumId)}?include=tracks,artists&extend=editorialVideo,editorialNotes`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Album fetch failed (${res.status})`);
  const json = await res.json();
  return json.data?.[0] || null;
}

async function fetchArtistDetail(artistId, storefront = 'us') {
  const url = `${WORKER_BASE}/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(artistId)}?include=albums,playlists&extend=editorialVideo,editorialNotes`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Artist fetch failed (${res.status})`);
  const json = await res.json();
  return json.data?.[0] || null;
}

async function fetchPlaylistDetail(playlistId, storefront = 'us') {
  const url = `${WORKER_BASE}/v1/catalog/${encodeURIComponent(storefront)}/playlists/${encodeURIComponent(playlistId)}?include=tracks&extend=editorialVideo,editorialNotes`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status})`);
  const json = await res.json();
  return json.data?.[0] || null;
}

/* ==========================================================================
   Render Top Header Bar (with Back History + Search)
   ========================================================================== */
function renderTopHeader() {
  const canGoBack = state.history.length > 0;
  return `
    <header class="main-top-header">
      <button
        id="backNavBtn"
        type="button"
        class="back-nav-btn"
        ${canGoBack ? '' : 'disabled'}
        title="Go back"
      >
        <span class="sf-icon" data-sf-symbol="chevron.left" aria-hidden="true"></span>
        <span>Back</span>
      </button>

      <form id="mainSearchForm" class="main-search-pill" autocomplete="off">
        <span class="sf-icon search-icon" data-sf-symbol="magnifyingglass" aria-hidden="true"></span>
        <input
          id="mainSearchInput"
          type="search"
          value="${escapeHtml(state.query)}"
          placeholder="Search catalog..."
          aria-label="Search catalog"
        />
      </form>

      <div class="top-header-spacer">${escapeHtml(state.storefront)}</div>
    </header>
  `;
}

function renderMediaCard(item, kind = 'album') {
  const attr = item.attributes || {};
  const title = attr.name || 'Untitled';
  const subtitle =
    kind === 'artist'
      ? (attr.genreNames || [])[0] || 'Artist'
      : kind === 'playlist'
        ? attr.curatorName || 'Playlist'
        : attr.artistName || '';
  const rawArt = attr.artwork?.url || '';
  const artUrl = formatArtworkUrl(rawArt, 440, 440);
  const isArtist = kind === 'artist';

  return `
    <article class="media-card ${isArtist ? 'is-artist' : ''}" data-open-kind="${kind}" data-open-id="${item.id}">
      <div class="media-card-art-wrap">
        ${artUrl ? `<img class="media-card-art" src="${artUrl}" alt="${escapeHtml(title)}" loading="lazy" />` : ''}
      </div>
      <div class="media-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
      ${!isArtist && subtitle ? `<div class="media-card-sub" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</div>` : ''}
    </article>
  `;
}

function renderQualityBadgesFromTracks(tracks = []) {
  const allVariants = new Set(tracks.flatMap((t) => t.attributes?.audioVariants || []));
  const traits = new Set(tracks.flatMap((t) => t.attributes?.audioTraits || []));

  const badges = [];
  if (allVariants.has('dolby-atmos') || traits.has('atmos') || traits.has('spatial')) {
    badges.push(`<span class="badge-icon badge-dolby" title="Dolby Atmos"></span>`);
  }
  if (allVariants.has('hi-res-lossless') || traits.has('hi-res-lossless')) {
    badges.push(`<span class="badge-icon badge-hires-lossless" title="Hi-Res Lossless"></span>`);
  } else if (allVariants.has('lossless') || traits.has('lossless')) {
    badges.push(`<span class="badge-icon badge-lossless" title="Lossless"></span>`);
  }
  return badges.join('');
}

function renderTrackQualityTags(tAttr = {}) {
  const variants = new Set(tAttr.audioVariants || []);
  const traits = new Set(tAttr.audioTraits || []);
  const tags = [];

  if (variants.has('dolby-atmos') || traits.has('atmos')) {
    tags.push(`<span class="quality-pill">Atmos</span>`);
  }
  if (variants.has('hi-res-lossless') || traits.has('hi-res-lossless')) {
    tags.push(`<span class="quality-pill">Hi-Res</span>`);
  } else if (variants.has('lossless') || traits.has('lossless')) {
    tags.push(`<span class="quality-pill">Lossless</span>`);
  }
  return tags.join('');
}

/* ==========================================================================
   Render Views: Search Canvas, Album, Artist & Playlist
   ========================================================================== */
function renderSearchView() {
  state.viewMode = 'search';
  document.documentElement.style.setProperty('--hero-tint', '#4a5373');
  const { albums, artists, songs, playlists, musicVideos } = state.searchResults;

  const topItems = [
    ...albums.slice(0, 2).map((d) => ({ kind: 'album', label: `Album · ${d.attributes?.artistName || ''}`, item: d })),
    ...artists.slice(0, 1).map((d) => ({ kind: 'artist', label: 'Artist', item: d })),
    ...songs.slice(0, 2).map((d) => ({ kind: 'song', label: `Song · ${d.attributes?.artistName || ''}`, item: d })),
    ...musicVideos.slice(0, 1).map((d) => ({ kind: 'music-video', label: `Music Video · ${d.attributes?.artistName || ''}`, item: d }))
  ].slice(0, 6);

  const topHtml = topItems.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn" data-copy-text="${escapeHtml(state.query)}">
            <span>Top</span>
            <span class="sf-icon" data-sf-symbol="chevron.right" aria-hidden="true"></span>
          </button>
        </div>
        <div class="top-grid">
          ${topItems
            .map(({ kind, label, item }) => {
              const attr = item.attributes || {};
              const art = formatArtworkUrl(attr.artwork?.url, 180, 180);
              const previewUrl = kind === 'song' ? attr.previews?.[0]?.url || '' : '';
              return `
                <button
                  type="button"
                  class="top-tile"
                  data-open-kind="${kind}"
                  data-open-id="${item.id}"
                  ${previewUrl ? `data-preview-url="${escapeHtml(previewUrl)}"` : ''}
                >
                  ${
                    art
                      ? `<img class="top-tile-art ${kind === 'artist' ? 'is-circle' : ''}" src="${art}" alt="${escapeHtml(attr.name || '')}" />`
                      : `<div class="top-tile-art ${kind === 'artist' ? 'is-circle' : ''}"></div>`
                  }
                  <div class="top-tile-meta">
                    <span class="top-tile-title">${escapeHtml(attr.name || '')}</span>
                    <span class="top-tile-sub">${escapeHtml(label)}</span>
                  </div>
                </button>
              `;
            })
            .join('')}
        </div>
      </section>
    `
    : '';

  const albumsShelf = albums.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn" data-filter-nav="albums">
            <span>Albums</span>
            <span class="sf-icon" data-sf-symbol="chevron.right" aria-hidden="true"></span>
          </button>
        </div>
        <div class="horizontal-shelf">
          ${albums.map((a) => renderMediaCard(a, 'album')).join('')}
        </div>
      </section>
    `
    : '';

  const artistsShelf = artists.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn" data-filter-nav="artists">
            <span>Artists</span>
            <span class="sf-icon" data-sf-symbol="chevron.right" aria-hidden="true"></span>
          </button>
        </div>
        <div class="horizontal-shelf">
          ${artists.map((ar) => renderMediaCard(ar, 'artist')).join('')}
        </div>
      </section>
    `
    : '';

  const playlistsShelf = playlists.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn" data-filter-nav="playlists">
            <span>Playlists</span>
            <span class="sf-icon" data-sf-symbol="chevron.right" aria-hidden="true"></span>
          </button>
        </div>
        <div class="horizontal-shelf">
          ${playlists.map((pl) => renderMediaCard(pl, 'playlist')).join('')}
        </div>
      </section>
    `
    : '';

  let orderedShelves = '';
  if (state.activeNav === 'artists') {
    orderedShelves = `${artistsShelf}${albumsShelf}${playlistsShelf}`;
  } else if (state.activeNav === 'playlists') {
    orderedShelves = `${playlistsShelf}${albumsShelf}${artistsShelf}`;
  } else {
    orderedShelves = `${albumsShelf}${artistsShelf}${playlistsShelf}`;
  }

  const emptyState =
    !topHtml && !orderedShelves
      ? `<div class="status-card">Search an album, artist, song, or playlist above to explore catalog &amp; editorial artwork.</div>`
      : '';

  dom.contentArea.innerHTML = `${renderTopHeader()}${topHtml}${orderedShelves}${emptyState}`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);
}

async function openAlbumDetail(albumId, { recordHistory = true } = {}) {
  if (recordHistory) pushHistory();
  state.viewMode = 'album';
  state.selectedId = albumId;
  dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Loading album details...</div>`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);

  try {
    const album = await fetchAlbumDetail(albumId, state.storefront);
    if (!album) {
      dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Album not found.</div>`;
      bindMainViewEvents();
      hydrateSfSymbols(dom.contentArea);
      return;
    }

    state.selectedData = album;
    const attr = album.attributes || {};
    const bgHex = attr.artwork?.bgColor ? `#${attr.artwork.bgColor}` : '#4a5373';
    document.documentElement.style.setProperty('--hero-tint', bgHex);

    const coverUrl = formatArtworkUrl(attr.artwork?.url, 600, 600);
    const year = attr.releaseDate ? attr.releaseDate.slice(0, 4) : '';
    const genre = (attr.genreNames || [])[0] || '';
    const editorialStandard = attr.editorialNotes?.standard || '';
    const plainEditorial = stripHtmlTags(editorialStandard);
    const needsTruncate = plainEditorial.length > 140;
    const tracks = album.relationships?.tracks?.data || [];
    const qualityBadgesHtml = renderQualityBadgesFromTracks(tracks);

    const metaParts = [genre, year, qualityBadgesHtml].filter(Boolean).join(' · ');

    const tracksHtml = tracks
      .map((track, idx) => {
        const tAttr = track.attributes || {};
        const previewUrl = tAttr.previews?.[0]?.url || '';
        const explicitBadge = tAttr.contentRating === 'explicit' ? `<span class="explicit-tag">E</span>` : '';
        const qualityTags = renderTrackQualityTags(tAttr);
        return `
          <div
            class="track-row"
            data-track-id="${track.id}"
            data-preview-url="${escapeHtml(previewUrl)}"
            data-track-title="${escapeHtml(tAttr.name || '')}"
          >
            <span class="track-num">${idx + 1}</span>
            <span class="track-title">${escapeHtml(tAttr.name || '')} ${explicitBadge}</span>
            <span class="track-badges">${qualityTags}</span>
            <span class="track-duration">${formatDuration(tAttr.durationInMillis)}</span>
          </div>
        `;
      })
      .join('');

    const moreAlbums = state.searchResults.albums.filter((a) => a.id !== album.id);
    const moreByArtistHtml = moreAlbums.length
      ? `
        <section class="shelf-section">
          <div class="shelf-header">
            <button type="button" class="shelf-title-btn">
              <span>More by ${escapeHtml(attr.artistName || 'Artist')}</span>
              <span class="sf-icon" data-sf-symbol="chevron.right" aria-hidden="true"></span>
            </button>
          </div>
          <div class="horizontal-shelf">
            ${moreAlbums.map((a) => renderMediaCard(a, 'album')).join('')}
          </div>
        </section>
      `
      : '';

    const artistId = album.relationships?.artists?.data?.[0]?.id || '';

    dom.contentArea.innerHTML = `
      ${renderTopHeader()}

      <section class="detail-hero">
        <button id="openMediaModalBtn" type="button" class="detail-cover-btn" title="Open hi-res static & animated artwork, M3U8/MP4 streams">
          ${coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(attr.name || '')}" />` : ''}
        </button>

        <div class="detail-hero-meta">
          <h1 class="detail-hero-title copyable-text" data-copy-text="${escapeHtml(attr.name || '')}">${escapeHtml(attr.name || '')}</h1>
          <div
            class="detail-hero-artist"
            ${artistId ? `data-open-kind="artist" data-open-id="${escapeHtml(artistId)}"` : `data-copy-text="${escapeHtml(attr.artistName || '')}"`}
          >${escapeHtml(attr.artistName || '')}</div>
          <div class="detail-meta-line">${metaParts}</div>

          ${
            editorialStandard
              ? `
                <div class="editorial-notes-box">
                  <span id="editorialNotesText">${formatEditorialHtml(editorialStandard)}</span>
                  ${
                    needsTruncate
                      ? `<button id="toggleNotesBtn" type="button" class="editorial-more-btn">LESS</button>`
                      : ''
                  }
                </div>
              `
              : ''
          }
        </div>
      </section>

      <section class="tracklist" aria-label="Tracklist">
        ${tracksHtml}
      </section>

      <footer class="release-footer">
        <div class="copyable-text" data-copy-text="${escapeHtml(attr.releaseDate || '')}">${escapeHtml(attr.releaseDate || '')}</div>
        <div>${tracks.length} songs, ${formatTotalMinutes(tracks)} minutes</div>
        <div class="copyable-text" data-copy-text="${escapeHtml(attr.copyright || '')}">${escapeHtml(attr.copyright || '')}</div>
        ${
          attr.url
            ? `<a class="itunes-link" href="${escapeHtml(attr.url)}" target="_blank" rel="noopener noreferrer">Also in iTunes</a>`
            : ''
        }
      </footer>

      ${moreByArtistHtml}
    `;

    const toggleBtn = document.getElementById('toggleNotesBtn');
    const notesEl = document.getElementById('editorialNotesText');
    if (toggleBtn && notesEl) {
      let expanded = true;
      const truncatedPlain = `${plainEditorial.slice(0, 137)}...`;
      toggleBtn.addEventListener('click', () => {
        expanded = !expanded;
        notesEl.innerHTML = expanded ? formatEditorialHtml(editorialStandard) : escapeHtml(truncatedPlain);
        toggleBtn.textContent = expanded ? 'LESS' : 'MORE';
      });
    }

    const mediaBtn = document.getElementById('openMediaModalBtn');
    if (mediaBtn) {
      mediaBtn.addEventListener('click', () => openItemMediaModal(album, 'album'));
    }

    document.querySelectorAll('.track-row').forEach((row) => {
      row.addEventListener('click', () => {
        toggleTrackPreview(row.dataset.trackId, row.dataset.previewUrl, row);
      });
    });

    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  } catch (err) {
    dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Error: ${escapeHtml(err.message)}</div>`;
    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  }
}

async function openArtistDetail(artistId, { recordHistory = true } = {}) {
  if (recordHistory) pushHistory();
  state.viewMode = 'artist';
  state.selectedId = artistId;
  dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Loading artist profile...</div>`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);

  try {
    const artist = await fetchArtistDetail(artistId, state.storefront);
    const cached = state.searchResults.artists.find((a) => a.id === artistId);
    const data = artist || cached;

    if (!data) {
      dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Artist not found.</div>`;
      bindMainViewEvents();
      hydrateSfSymbols(dom.contentArea);
      return;
    }

    state.selectedData = data;
    const attr = data.attributes || {};
    const bgHex = attr.artwork?.bgColor ? `#${attr.artwork.bgColor}` : '#4a5373';
    document.documentElement.style.setProperty('--hero-tint', bgHex);

    const artUrl = formatArtworkUrl(attr.artwork?.url, 600, 600);
    const genres = (attr.genreNames || []).slice(0, 3).join(' · ');
    const editorialRaw = attr.editorialNotes?.standard || attr.editorialNotes?.short || '';
    const relAlbums = data.relationships?.albums?.data || state.searchResults.albums || [];

    dom.contentArea.innerHTML = `
      ${renderTopHeader()}

      <section class="detail-hero">
        <button id="openMediaModalBtn" type="button" class="detail-cover-btn is-artist" title="Open artist artwork & editorial motion">
          ${artUrl ? `<img src="${artUrl}" alt="${escapeHtml(attr.name || '')}" />` : ''}
        </button>

        <div class="detail-hero-meta">
          <h1 class="detail-hero-title copyable-text" data-copy-text="${escapeHtml(attr.name || '')}">${escapeHtml(attr.name || '')}</h1>
          <div class="detail-meta-line">${escapeHtml(genres || 'Artist')}</div>
          ${
            editorialRaw
              ? `<div class="editorial-notes-box">${formatEditorialHtml(editorialRaw)}</div>`
              : ''
          }
          <div class="action-row" style="margin-top: 0.5rem;">
            <button type="button" class="btn-ghost" id="artistSearchAllBtn">Search "${escapeHtml(attr.name || '')}" releases</button>
          </div>
        </div>
      </section>

      ${
        relAlbums.length
          ? `
            <section class="shelf-section">
              <div class="shelf-header">
                <span class="shelf-title-btn">Albums &amp; Releases</span>
              </div>
              <div class="horizontal-shelf">
                ${relAlbums.map((a) => renderMediaCard(a, 'album')).join('')}
              </div>
            </section>
          `
          : ''
      }
    `;

    document.getElementById('openMediaModalBtn')?.addEventListener('click', () => openItemMediaModal(data, 'artist'));
    document.getElementById('artistSearchAllBtn')?.addEventListener('click', () => runSearch(attr.name || ''));

    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  } catch (err) {
    dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Error: ${escapeHtml(err.message)}</div>`;
    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  }
}

async function openPlaylistDetail(playlistId, { recordHistory = true } = {}) {
  if (recordHistory) pushHistory();
  state.viewMode = 'playlist';
  state.selectedId = playlistId;
  dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Loading playlist...</div>`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);

  try {
    const playlist = await fetchPlaylistDetail(playlistId, state.storefront);
    const cached = state.searchResults.playlists.find((p) => p.id === playlistId);
    const data = playlist || cached;

    if (!data) {
      dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Playlist not found.</div>`;
      bindMainViewEvents();
      hydrateSfSymbols(dom.contentArea);
      return;
    }

    state.selectedData = data;
    const attr = data.attributes || {};
    const bgHex = attr.artwork?.bgColor ? `#${attr.artwork.bgColor}` : '#4a5373';
    document.documentElement.style.setProperty('--hero-tint', bgHex);

    const artUrl = formatArtworkUrl(attr.artwork?.url, 600, 600);
    const descRaw = attr.description?.standard || attr.editorialNotes?.standard || '';
    const tracks = data.relationships?.tracks?.data || [];

    const tracksHtml = tracks
      .map((track, idx) => {
        const tAttr = track.attributes || {};
        const previewUrl = tAttr.previews?.[0]?.url || '';
        return `
          <div
            class="track-row"
            data-track-id="${track.id}"
            data-preview-url="${escapeHtml(previewUrl)}"
          >
            <span class="track-num">${idx + 1}</span>
            <span class="track-title">${escapeHtml(tAttr.name || '')} — ${escapeHtml(tAttr.artistName || '')}</span>
            <span class="track-badges">${renderTrackQualityTags(tAttr)}</span>
            <span class="track-duration">${formatDuration(tAttr.durationInMillis)}</span>
          </div>
        `;
      })
      .join('');

    dom.contentArea.innerHTML = `
      ${renderTopHeader()}

      <section class="detail-hero">
        <button id="openMediaModalBtn" type="button" class="detail-cover-btn" title="Open playlist artwork & streams">
          ${artUrl ? `<img src="${artUrl}" alt="${escapeHtml(attr.name || '')}" />` : ''}
        </button>

        <div class="detail-hero-meta">
          <h1 class="detail-hero-title copyable-text" data-copy-text="${escapeHtml(attr.name || '')}">${escapeHtml(attr.name || '')}</h1>
          <div class="detail-hero-artist">${escapeHtml(attr.curatorName || 'Apple Music')}</div>
          ${descRaw ? `<div class="editorial-notes-box">${formatEditorialHtml(descRaw)}</div>` : ''}
        </div>
      </section>

      ${
        tracks.length
          ? `<section class="tracklist" aria-label="Playlist tracks">${tracksHtml}</section>`
          : `<div class="status-card">No track preview list returned for this playlist.</div>`
      }
    `;

    document.getElementById('openMediaModalBtn')?.addEventListener('click', () => openItemMediaModal(data, 'playlist'));
    document.querySelectorAll('.track-row').forEach((row) => {
      row.addEventListener('click', () => {
        toggleTrackPreview(row.dataset.trackId, row.dataset.previewUrl, row);
      });
    });

    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  } catch (err) {
    dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Error: ${escapeHtml(err.message)}</div>`;
    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  }
}

/* ==========================================================================
   Artwork, Variant Selector, M3U8 / MP4 Streams & Markdown Modal
   ========================================================================== */
async function openItemMediaModal(item, kind = 'album') {
  cleanupHlsPlayers();
  const attr = item.attributes || {};
  const maxW = attr.artwork?.width || 3000;
  const maxH = attr.artwork?.height || 3000;
  const maxArtworkUrl = formatArtworkUrl(attr.artwork?.url, maxW, maxH);

  dom.modalTitle.textContent = attr.name || 'Artwork & Media';
  dom.modalSubtitle.textContent = `${attr.artistName || attr.curatorName || kind} · Max static ${maxW}x${maxH}`;
  dom.modalBody.innerHTML = `
    <div class="modal-section">
      <h3>Static Artwork</h3>
      <div class="action-row">
        ${maxArtworkUrl ? `<a class="btn-pill" href="${escapeHtml(maxArtworkUrl)}" target="_blank" rel="noopener noreferrer">Open Max Static (${maxW}x${maxH})</a>` : ''}
        ${maxArtworkUrl ? `<button type="button" class="btn-ghost" id="copyStaticUrlBtn">Copy Static URL</button>` : ''}
      </div>
    </div>
    <div class="modal-section">
      <h3>Animated Artwork Variants &amp; M3U8 / MP4 Streams</h3>
      <div id="motionVariantsContainer" class="status-card">Inspecting editorialVideo variants &amp; streams...</div>
    </div>
  `;

  dom.mediaModal.hidden = false;
  hydrateSfSymbols(dom.mediaModal);

  document.getElementById('copyStaticUrlBtn')?.addEventListener('click', () => {
    copyToClipboard(maxArtworkUrl, 'Copied static artwork URL');
  });

  const editorialVideo = attr.editorialVideo || {};
  const entries = Object.entries(editorialVideo).filter(([, v]) => v && (v.video || v.previewFrame?.url));
  const container = document.getElementById('motionVariantsContainer');

  if (!entries.length) {
    container.textContent = 'No animated artwork variants found for this item.';
    return;
  }

  const variants = [];
  for (const [key, vData] of entries) {
    const masterUrl = vData.video || '';
    const posterUrl = formatArtworkUrl(vData.previewFrame?.url || attr.artwork?.url, 600, 600);
    let streams = [];
    if (masterUrl) {
      try {
        const res = await fetch(masterUrl);
        if (res.ok) {
          streams = parseM3U8(await res.text());
        }
      } catch {
        // ignore fetch error on playlist
      }
    }
    variants.push({
      key,
      label: key,
      masterUrl,
      posterUrl,
      streams
    });
  }

  let selectedIndex = 0;

  const renderVariantDetail = (idx) => {
    cleanupHlsPlayers();
    const v = variants[idx];
    const isTall = v.key.toLowerCase().includes('tall') || v.key.toLowerCase().includes('3x4');
    const chosenStreamUrl = v.streams.find((s) => s.resolution.includes('1080'))?.url || v.streams[0]?.url || v.masterUrl;

    const mdLines = [`### ${v.label}`];
    if (v.masterUrl) mdLines.push(`[Master M3U8](<${v.masterUrl}>)`);
    v.streams.forEach((s) => {
      const mp4 = toMp4Url(s.url);
      mdLines.push(`- ${s.resolution}: [M3U8](<${s.url}>) • [MP4](<${mp4}>)`);
    });
    const markdownText = mdLines.join('
');

    container.className = '';
    container.innerHTML = `
      <div class="variant-tabs" role="tablist">
        ${variants
          .map(
            (itemV, i) => `
              <button
                type="button"
                class="variant-chip ${i === idx ? 'is-active' : ''}"
                data-variant-idx="${i}"
              >${escapeHtml(itemV.label)}</button>
            `
          )
          .join('')}
      </div>

      <div class="motion-grid">
        <div class="motion-card ${isTall ? 'is-tall' : ''}">
          ${
            v.masterUrl
              ? `<video id="activeVariantVideo" autoplay loop muted playsinline controls poster="${escapeHtml(v.posterUrl)}"></video>`
              : `<img src="${escapeHtml(v.posterUrl)}" alt="${escapeHtml(v.label)}" />`
          }
          <div><strong>${escapeHtml(v.label)}</strong></div>
          <div class="action-row" style="margin-bottom:0;">
            ${
              v.masterUrl
                ? `<a class="btn-ghost" href="${escapeHtml(v.masterUrl)}" target="_blank" rel="noopener noreferrer">Master .m3u8</a>
                   <button type="button" class="btn-ghost" id="copyMasterM3u8Btn">Copy .m3u8</button>`
                : ''
            }
          </div>
        </div>

        <div>
          <div class="action-row">
            <button type="button" class="btn-pill" id="copyVariantMdBtn">Copy Markdown</button>
          </div>
          <textarea class="md-output" readonly>${escapeHtml(markdownText)}</textarea>
        </div>
      </div>

      ${
        v.streams.length
          ? `
            <div class="stream-list">
              ${v.streams
                .map((s) => {
                  const mp4Url = toMp4Url(s.url);
                  return `
                    <div class="stream-row">
                      <div class="stream-meta">
                        <strong>${escapeHtml(s.resolution || 'Variant')}</strong>
                        <span class="stream-url">${escapeHtml(s.url)}</span>
                      </div>
                      <div class="action-row" style="margin-bottom:0;">
                        <button type="button" class="btn-ghost copy-stream-btn" data-url="${escapeHtml(s.url)}">M3U8</button>
                        <a class="btn-pill" href="${escapeHtml(mp4Url)}" target="_blank" rel="noopener noreferrer">MP4</a>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
          : ''
      }
    `;

    const videoEl = document.getElementById('activeVariantVideo');
    if (videoEl && chosenStreamUrl) {
      attachHlsToVideo(videoEl, chosenStreamUrl);
    }

    container.querySelectorAll('[data-variant-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedIndex = parseInt(btn.dataset.variantIdx, 10);
        renderVariantDetail(selectedIndex);
      });
    });

    document.getElementById('copyMasterM3u8Btn')?.addEventListener('click', () => {
      copyToClipboard(v.masterUrl, 'Copied Master M3U8 URL');
    });

    document.getElementById('copyVariantMdBtn')?.addEventListener('click', () => {
      copyToClipboard(markdownText, 'Copied variant Markdown');
    });

    container.querySelectorAll('.copy-stream-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyToClipboard(btn.dataset.url || '', 'Copied M3U8 stream URL');
      });
    });
  };

  renderVariantDetail(selectedIndex);
}

function closeMediaModal() {
  cleanupHlsPlayers();
  dom.mediaModal.hidden = true;
}

/* ==========================================================================
   Event Wiring & Initialization
   ========================================================================== */
async function runSearch(term, { recordHistory = true } = {}) {
  const cleaned = term.trim();
  if (!cleaned) return;
  if (recordHistory && state.query && cleaned !== state.query) {
    pushHistory();
  }
  state.query = cleaned;
  state.viewMode = 'search';
  dom.sidebarSearchInput.value = cleaned;

  dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Searching catalog...</div>`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);

  try {
    state.searchResults = await fetchCatalogSearch(cleaned, state.storefront);
    renderSearchView();
  } catch (err) {
    dom.contentArea.innerHTML = `${renderTopHeader()}<div class="status-card">Search error: ${escapeHtml(err.message)}</div>`;
    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  }
}

function bindMainViewEvents() {
  document.getElementById('backNavBtn')?.addEventListener('click', goBack);

  const mainForm = document.getElementById('mainSearchForm');
  const mainInput = document.getElementById('mainSearchInput');
  if (mainForm && mainInput) {
    mainForm.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch(mainInput.value);
    });
  }

  dom.contentArea.querySelectorAll('[data-filter-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeNav = btn.dataset.filterNav;
      syncNavActiveState();
      renderSearchView();
    });
  });

  dom.contentArea.querySelectorAll('[data-open-kind][data-open-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const kind = el.dataset.openKind;
      const id = el.dataset.openId;
      if (kind === 'album') {
        openAlbumDetail(id);
      } else if (kind === 'artist') {
        openArtistDetail(id);
      } else if (kind === 'playlist') {
        openPlaylistDetail(id);
      } else if (kind === 'song') {
        const song = state.searchResults.songs.find((s) => s.id === id);
        const preview = song?.attributes?.previews?.[0]?.url || el.dataset.previewUrl || '';
        toggleTrackPreview(id, preview, el);
      } else {
        const text = el.querySelector('.top-tile-title, .media-card-title')?.textContent?.trim() || '';
        if (text) copyToClipboard(text, `Copied "${text}"`);
      }
    });
  });

  dom.contentArea.querySelectorAll('.copyable-text, [data-copy-text]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const text = el.dataset.copyText || el.textContent?.trim();
      if (!text) return;
      if (!el.hasAttribute('data-open-kind')) {
        e.stopPropagation();
        copyToClipboard(text, 'Copied to clipboard');
      }
    });
  });
}

dom.mobileNavToggle?.addEventListener('click', () => {
  const expanded = dom.sidebar.classList.toggle('is-expanded');
  dom.mobileNavToggle.setAttribute('aria-expanded', String(expanded));
});

dom.sidebarSearchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  state.storefront = dom.storefrontInput.value.trim().toLowerCase() || 'us';
  runSearch(dom.sidebarSearchInput.value);
  dom.sidebar.classList.remove('is-expanded');
});

dom.storefrontInput.addEventListener('change', () => {
  state.storefront = dom.storefrontInput.value.trim().toLowerCase() || 'us';
  if (state.query) runSearch(state.query, { recordHistory: false });
});

dom.navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    pushHistory();
    state.activeNav = btn.dataset.nav;
    syncNavActiveState();
    state.viewMode = 'search';
    renderSearchView();
    dom.sidebar.classList.remove('is-expanded');
  });
});

dom.brandResetBtn.addEventListener('click', () => {
  pushHistory();
  state.viewMode = 'search';
  state.selectedId = null;
  state.selectedData = null;
  renderSearchView();
});

dom.modalCloseBtn.addEventListener('click', closeMediaModal);
dom.mediaModal.addEventListener('click', (e) => {
  if (e.target === dom.mediaModal) closeMediaModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dom.mediaModal.hidden) closeMediaModal();
});

hydrateSfSymbols(document);
renderSearchView();
