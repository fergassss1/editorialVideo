const WORKER_BASE = 'https://amphoreus.ejpoacc.workers.dev';
const SF_SYMBOL_BASE = 'https://raw.githubusercontent.com/brendanballon/sfsymbols-svg/master/symbols';

const state = {
  query: '',
  storefront: 'us',
  activeNav: 'albums',
  viewMode: 'search', // 'search' | 'album'
  selectedAlbumId: null,
  selectedAlbumData: null,
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

      // Prefer Regular-S or Medium-S layer if present so we don't render multi-weight/template overlays
      const preferredLayer =
        svg.querySelector('#Regular-S') ||
        svg.querySelector('[id*="Regular-S"]') ||
        svg.querySelector('#Medium-S') ||
        svg.querySelector('[id*="Medium-S"]');

      let targetContainer = svg;
      if (preferredLayer) {
        const wrapper = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
        const cloned = preferredLayer.cloneNode(true);
        cloned.removeAttribute('transform');
        wrapper.appendChild(cloned);
        svg.innerHTML = '';
        svg.appendChild(wrapper);
      }

      // Remove bounding rectangles, guide lines, and non-glyph template layers
      svg.querySelectorAll('rect, line, #Notes, #Guides, [id*="Notes"], [id*="Guides"]').forEach((el) => {
        el.remove();
      });

      // Strip strokes/outlines and force fill="currentColor"
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
   Helpers: Formatting, Clipboard, Audio Preview, HLS & M3U8
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
    document.querySelectorAll('.track-row.is-playing').forEach((r) => r.classList.remove('is-playing'));
    return;
  }

  document.querySelectorAll('.track-row.is-playing').forEach((r) => r.classList.remove('is-playing'));
  dom.previewAudio.src = previewUrl;
  dom.previewAudio.play().catch(() => showToast('Unable to play preview'));
  state.playingTrackId = trackId;
  if (rowEl) rowEl.classList.add('is-playing');
}

dom.previewAudio.addEventListener('ended', () => {
  state.playingTrackId = null;
  document.querySelectorAll('.track-row.is-playing').forEach((r) => r.classList.remove('is-playing'));
});

function toMp4Url(url) {
  if (!url) return '';
  return url.replace(/\.m3u8(\?.*)?$/, '-$.mp4'.replace('$', '')).replace(/\.m3u8$/, '-.mp4');
}

function parseM3U8(content) {
  const streams = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = line.substring(18);
      const resMatch = attrs.match(/RESOLUTION=([0-9x]+)/);
      const bwMatch = attrs.match(/BANDWIDTH=([0-9]+)/);
      const nextUrl = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1].trim() : '';
      if (nextUrl) {
        streams.push({
          resolution: resMatch ? resMatch[1] : '',
          bandwidthNum: bwMatch ? parseInt(bwMatch[1], 10) : 0,
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

/* ==========================================================================
   AMP-API Requests via Cloudflare Worker
   ========================================================================== */
async function fetchCatalogSearch(term, storefront = 'us') {
  const types = 'albums,artists,songs,playlists,music-videos';
  const url = `${WORKER_BASE}/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(term)}&types=${types}&extend=editorialVideo&limit=12`;
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

/* ==========================================================================
   Render Views: Search Canvas & Album Detail View
   ========================================================================== */
function renderTopSearchBar() {
  return `
    <div class="main-search-bar-wrap">
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
    </div>
  `;
}

function renderMediaCard(item, kind = 'album') {
  const attr = item.attributes || {};
  const title = attr.name || 'Untitled';
  const subtitle =
    kind === 'artist'
      ? ''
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

function renderSearchView() {
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
              return `
                <button type="button" class="top-tile" data-open-kind="${kind}" data-open-id="${item.id}">
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

  const albumsHtml = albums.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn">
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

  const artistsHtml = artists.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn">
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

  const playlistsHtml = playlists.length
    ? `
      <section class="shelf-section">
        <div class="shelf-header">
          <button type="button" class="shelf-title-btn">
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

  const emptyState =
    !topHtml && !albumsHtml && !artistsHtml && !playlistsHtml
      ? `<div class="status-card">Search an album, artist, song, or playlist above to explore catalog &amp; editorial artwork.</div>`
      : '';

  dom.contentArea.innerHTML = `${renderTopSearchBar()}${topHtml}${albumsHtml}${artistsHtml}${playlistsHtml}${emptyState}`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);
}

async function openAlbumDetail(albumId) {
  state.viewMode = 'album';
  state.selectedAlbumId = albumId;
  dom.contentArea.innerHTML = `${renderTopSearchBar()}<div class="status-card">Loading album details...</div>`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);

  try {
    const album = await fetchAlbumDetail(albumId, state.storefront);
    if (!album) {
      dom.contentArea.innerHTML = `${renderTopSearchBar()}<div class="status-card">Album not found.</div>`;
      return;
    }

    state.selectedAlbumData = album;
    const attr = album.attributes || {};
    const bgHex = attr.artwork?.bgColor ? `#${attr.artwork.bgColor}` : '#4a5373';
    document.documentElement.style.setProperty('--hero-tint', bgHex);

    const coverUrl = formatArtworkUrl(attr.artwork?.url, 600, 600);
    const year = attr.releaseDate ? attr.releaseDate.slice(0, 4) : '';
    const genre = (attr.genreNames || [])[0] || '';
    const editorialStandard = attr.editorialNotes?.standard || '';
    const shortNotes = editorialStandard.length > 130 ? `${editorialStandard.slice(0, 127)}...` : editorialStandard;
    const tracks = album.relationships?.tracks?.data || [];

    // Audio variant badges derived from track audioVariants when available
    const allVariants = new Set(
      tracks.flatMap((t) => t.attributes?.audioVariants || [])
    );
    const qualityBadgesHtml = [
      allVariants.has('dolby-atmos') ? `<span class="badge-icon badge-dolby" title="Dolby Atmos"></span>` : '',
      allVariants.has('hi-res-lossless')
        ? `<span class="badge-icon badge-hires-lossless" title="Hi-Res Lossless"></span>`
        : allVariants.has('lossless')
          ? `<span class="badge-icon badge-lossless" title="Lossless"></span>`
          : ''
    ].join('');

    const metaParts = [genre, year, qualityBadgesHtml].filter(Boolean).join(' · ');

    const tracksHtml = tracks
      .map((track, idx) => {
        const tAttr = track.attributes || {};
        const previewUrl = tAttr.previews?.[0]?.url || '';
        const explicitBadge = tAttr.contentRating === 'explicit' ? `<span class="explicit-tag">E</span>` : '';
        return `
          <div
            class="track-row"
            data-track-id="${track.id}"
            data-preview-url="${escapeHtml(previewUrl)}"
            data-track-title="${escapeHtml(tAttr.name || '')}"
          >
            <span class="track-num">${idx + 1}</span>
            <span class="track-title">${escapeHtml(tAttr.name || '')} ${explicitBadge}</span>
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

    dom.contentArea.innerHTML = `
      ${renderTopSearchBar()}

      <section class="album-hero">
        <button id="openArtworkModalBtn" type="button" class="album-cover-btn" title="Open hi-res static & animated artwork">
          ${coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(attr.name || '')}" />` : ''}
        </button>

        <div class="album-hero-meta">
          <h1 class="album-hero-title copyable-text" data-copy-text="${escapeHtml(attr.name || '')}">${escapeHtml(attr.name || '')}</h1>
          <div class="album-hero-artist copyable-text" data-copy-text="${escapeHtml(attr.artistName || '')}">${escapeHtml(attr.artistName || '')}</div>
          <div class="album-meta-line">${metaParts}</div>

          ${
            editorialStandard
              ? `
                <div class="editorial-notes-box">
                  <span id="editorialNotesText">${escapeHtml(shortNotes)}</span>
                  ${
                    editorialStandard.length > 130
                      ? `<button id="toggleNotesBtn" type="button" class="editorial-more-btn">MORE</button>`
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
    if (toggleBtn) {
      let expanded = false;
      toggleBtn.addEventListener('click', () => {
        expanded = !expanded;
        document.getElementById('editorialNotesText').textContent = expanded ? editorialStandard : shortNotes;
        toggleBtn.textContent = expanded ? 'LESS' : 'MORE';
      });
    }

    const artModalBtn = document.getElementById('openArtworkModalBtn');
    if (artModalBtn) {
      artModalBtn.addEventListener('click', () => openAlbumMediaModal(album));
    }

    document.querySelectorAll('.track-row').forEach((row) => {
      row.addEventListener('click', () => {
        toggleTrackPreview(row.dataset.trackId, row.dataset.previewUrl, row);
      });
    });

    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  } catch (err) {
    dom.contentArea.innerHTML = `${renderTopSearchBar()}<div class="status-card">Error: ${escapeHtml(err.message)}</div>`;
    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  }
}

/* ==========================================================================
   Artwork & Animated Artwork Modal (includes Markdown export)
   ========================================================================== */
async function openAlbumMediaModal(album) {
  cleanupHlsPlayers();
  const attr = album.attributes || {};
  const maxW = attr.artwork?.width || 3000;
  const maxH = attr.artwork?.height || 3000;
  const maxArtworkUrl = formatArtworkUrl(attr.artwork?.url, maxW, maxH);

  dom.modalTitle.textContent = attr.name || 'Artwork';
  dom.modalSubtitle.textContent = `${attr.artistName || ''} · Max static ${maxW}x${maxH}`;
  dom.modalBody.innerHTML = `
    <div class="modal-section">
      <h3>Static Artwork</h3>
      <div class="action-row">
        ${maxArtworkUrl ? `<a class="btn-pill" href="${escapeHtml(maxArtworkUrl)}" target="_blank" rel="noopener noreferrer">Open Max Static (${maxW}x${maxH})</a>` : ''}
        ${maxArtworkUrl ? `<button type="button" class="btn-ghost" id="copyStaticUrlBtn">Copy Static URL</button>` : ''}
      </div>
    </div>
    <div class="modal-section">
      <h3>Animated Artwork &amp; Markdown</h3>
      <div id="motionVariantsContainer" class="status-card">Inspecting editorialVideo variants...</div>
    </div>
  `;

  dom.mediaModal.hidden = false;
  hydrateSfSymbols(dom.mediaModal);

  const copyStaticBtn = document.getElementById('copyStaticUrlBtn');
  if (copyStaticBtn) {
    copyStaticBtn.addEventListener('click', () => copyToClipboard(maxArtworkUrl, 'Copied static artwork URL'));
  }

  const editorialVideo = attr.editorialVideo || {};
  const entries = Object.entries(editorialVideo).filter(([, v]) => v?.video);
  const container = document.getElementById('motionVariantsContainer');

  if (!entries.length) {
    container.textContent = 'No animated artwork variants found for this release.';
    return;
  }

  const seenTypes = new Set();
  const cardsHtml = [];
  const hlsQueue = [];
  let squareMd = null;
  let tallMd = null;

  for (const [key, vData] of entries) {
    const lower = key.toLowerCase();
    let variantType = null;
    let label = key;
    let isTall = false;

    if (lower.includes('square') || lower.includes('detaildog') || lower.includes('detailmin')) {
      if (seenTypes.has('square')) continue;
      seenTypes.add('square');
      variantType = 'square';
      label = 'Square (1:1)';
    } else if (lower.includes('tall')) {
      if (seenTypes.has('tall')) continue;
      seenTypes.add('tall');
      variantType = 'tall';
      label = 'Tall (3:4)';
      isTall = true;
    } else {
      continue;
    }

    const vidId = `hls-${Math.random().toString(36).slice(2, 9)}`;
    const masterUrl = vData.video;
    const posterUrl = formatArtworkUrl(vData.previewFrame?.url, 400, 400);

    let playUrl = masterUrl;
    try {
      const m3u8Res = await fetch(masterUrl);
      if (m3u8Res.ok) {
        const parsed = parseM3U8(await m3u8Res.text());
        if (parsed.length) {
          const v1080 = parsed.find((s) => s.resolution.includes('1080')) || parsed[0];
          playUrl = v1080.url;
          if (variantType === 'square') {
            squareMd = {
              res1080: pickBestStream(parsed, '1080x1080'),
              res2160: pickBestStream(parsed, '2160x2160'),
              masterUrl
            };
          } else {
            tallMd = {
              res1080: pickBestStream(parsed, '1080x1440'),
              res2048: pickBestStream(parsed, '2048x2732'),
              masterUrl
            };
          }
        }
      }
    } catch {
      if (variantType === 'square') squareMd = { res1080: null, res2160: null, masterUrl };
      if (variantType === 'tall') tallMd = { res1080: null, res2048: null, masterUrl };
    }

    hlsQueue.push({ vidId, playUrl });
    cardsHtml.push(`
      <div class="motion-card ${isTall ? 'is-tall' : ''}">
        <video id="${vidId}" autoplay loop muted playsinline poster="${escapeHtml(posterUrl)}"></video>
        <div><strong>${escapeHtml(label)}</strong></div>
        <a class="btn-ghost" href="${escapeHtml(masterUrl)}" target="_blank" rel="noopener noreferrer">Master .m3u8</a>
      </div>
    `);
  }

  const mdLines = ['Animated Artwork'];
  if (squareMd) {
    mdLines.push('### Square');
    const parts = [
      squareMd.res1080 ? `[1080x1080](<${squareMd.res1080}>)` : '',
      squareMd.res2160 ? `[2160x2160](<${squareMd.res2160}>)` : '',
      squareMd.masterUrl ? `[Master M3U8](<${squareMd.masterUrl}>)` : ''
    ].filter(Boolean);
    if (parts.length) mdLines.push(parts.join(' • '));
  }
  if (tallMd) {
    mdLines.push('### Tall');
    const parts = [
      tallMd.res1080 ? `[1080x1440](<${tallMd.res1080}>)` : '',
      tallMd.res2048 ? `[2048x2732](<${tallMd.res2048}>)` : '',
      tallMd.masterUrl ? `[Master M3U8](<${tallMd.masterUrl}>)` : ''
    ].filter(Boolean);
    if (parts.length) mdLines.push(parts.join(' • '));
  }
  mdLines.push('-# Master M3U8 compatible with Firefox.');
  const markdownText = mdLines.join('\n');

  container.className = '';
  container.innerHTML = `
    <div class="motion-grid">${cardsHtml.join('')}</div>
    <div style="margin-top: 1rem;">
      <div class="action-row">
        <button type="button" class="btn-pill" id="copyMarkdownBtn">Copy Markdown</button>
      </div>
      <textarea id="modalMarkdownArea" class="md-output" readonly>${escapeHtml(markdownText)}</textarea>
    </div>
  `;

  document.getElementById('copyMarkdownBtn')?.addEventListener('click', () => {
    copyToClipboard(markdownText, 'Copied Markdown');
  });

  for (const { vidId, playUrl } of hlsQueue) {
    const videoEl = document.getElementById(vidId);
    if (!videoEl || !playUrl) continue;
    if (Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 5, maxMaxBufferLength: 10 });
      hls.loadSource(playUrl);
      hls.attachMedia(videoEl);
      activeHlsInstances.push(hls);
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = playUrl;
    }
  }
}

function closeMediaModal() {
  cleanupHlsPlayers();
  dom.mediaModal.hidden = true;
}

/* ==========================================================================
   Event Wiring & Initialization
   ========================================================================== */
async function runSearch(term) {
  const cleaned = term.trim();
  if (!cleaned) return;
  state.query = cleaned;
  state.viewMode = 'search';
  dom.sidebarSearchInput.value = cleaned;

  dom.contentArea.innerHTML = `${renderTopSearchBar()}<div class="status-card">Searching catalog...</div>`;
  bindMainViewEvents();
  hydrateSfSymbols(dom.contentArea);

  try {
    state.searchResults = await fetchCatalogSearch(cleaned, state.storefront);
    renderSearchView();
  } catch (err) {
    dom.contentArea.innerHTML = `${renderTopSearchBar()}<div class="status-card">Search error: ${escapeHtml(err.message)}</div>`;
    bindMainViewEvents();
    hydrateSfSymbols(dom.contentArea);
  }
}

function bindMainViewEvents() {
  const mainForm = document.getElementById('mainSearchForm');
  const mainInput = document.getElementById('mainSearchInput');
  if (mainForm && mainInput) {
    mainForm.addEventListener('submit', (e) => {
      e.preventDefault();
      runSearch(mainInput.value);
    });
  }

  dom.contentArea.querySelectorAll('[data-open-kind][data-open-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const kind = el.dataset.openKind;
      const id = el.dataset.openId;
      if (kind === 'album') {
        openAlbumDetail(id);
      } else if (kind === 'artist') {
        const artist = state.searchResults.artists.find((a) => a.id === id);
        if (artist) runSearch(artist.attributes?.name || '');
      } else if (kind === 'song') {
        const song = state.searchResults.songs.find((s) => s.id === id);
        const preview = song?.attributes?.previews?.[0]?.url || '';
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

dom.sidebarSearchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  state.storefront = dom.storefrontInput.value.trim().toLowerCase() || 'us';
  runSearch(dom.sidebarSearchInput.value);
});

dom.storefrontInput.addEventListener('change', () => {
  state.storefront = dom.storefrontInput.value.trim().toLowerCase() || 'us';
  if (state.query) runSearch(state.query);
});

dom.navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    dom.navItems.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.activeNav = btn.dataset.nav;
    state.viewMode = 'search';
    renderSearchView();
  });
});

dom.brandResetBtn.addEventListener('click', () => {
  state.viewMode = 'search';
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
