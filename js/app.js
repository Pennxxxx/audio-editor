/**
 * 音频剪辑工具 - 核心逻辑 v2
 * WaveSurfer.js v7 + Web Audio API
 */

/* ===================== 状态管理 ===================== */
const state = {
  tracks: [],
  activeTrackId: null,
  ws: null,
  wsRegions: null,
  activeRegion: null,
  isPlaying: false,
  exportFmt: 'mp3',
  exportBitrate: 128,
  exportBitDepth: 16,
};

/* ===================== DOM 引用 ===================== */
const $ = id => document.getElementById(id);
const dom = {
  fileInput:       $('file-input'),
  trackList:       $('track-list'),
  waveformEmpty:   $('waveform-empty'),
  waveformDiv:     $('waveform'),
  timelineDiv:     $('timeline'),
  playbackBar:     $('playback-bar'),
  cutToolbar:      $('cut-toolbar'),
  btnImport:       $('btn-import'),
  btnExport:       $('btn-export'),
  btnMerge:        $('btn-merge'),
  btnPlay:         $('btn-play'),
  btnSkipBack:     $('btn-skip-back'),
  btnSkipFwd:      $('btn-skip-fwd'),
  iconPlay:        $('icon-play'),
  iconPause:       $('icon-pause'),
  timeCurrent:     $('time-current'),
  timeTotal:       $('time-total'),
  speedSelect:     $('speed-select'),
  volumeSlider:    $('volume-slider'),
  regionStart:     $('region-start'),
  regionEnd:       $('region-end'),
  btnSetRegion:    $('btn-set-region'),
  btnCut:          $('btn-cut'),
  btnDeleteRegion: $('btn-delete-region'),
  btnClearRegion:  $('btn-clear-region'),
  dropZone:        $('drop-zone'),
  exportModal:     $('export-modal'),
  modalClose:      $('modal-close'),
  exportFilename:  $('export-filename'),
  formatTabs:      document.querySelectorAll('.format-tab'),
  mp3Options:      $('mp3-options'),
  wavOptions:      $('wav-options'),
  mp3Bitrate:      $('mp3-bitrate'),
  wavBitdepth:     $('wav-bitdepth'),
  exportDuration:  $('export-duration-label'),
  exportSizeHint:  $('export-size-hint'),
  btnDoExport:     $('btn-do-export'),
  exportProgress:  $('export-progress-area'),
  progressFill:    $('export-progress-fill'),
  progressLabel:   $('export-progress-label'),
  toast:           $('toast'),
};

/* ===================== 工具函数 ===================== */
let toastTimer;
function showToast(msg, type = '', duration = 2800) {
  dom.toast.textContent = msg;
  dom.toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.className = 'toast'; }, duration);
}

function formatTime(sec) {
  if (isNaN(sec) || sec < 0) return '0:00.000';
  const m  = Math.floor(sec / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${m}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/* ===================== 解析 WaveSurfer v7 插件引用 ===================== */
// v7 CDN UMD 构建：挂载到 window.WaveSurfer.Regions / window.WaveSurfer.Timeline
function getRegionsPlugin() {
  return window.WaveSurfer && window.WaveSurfer.Regions;
}
function getTimelinePlugin() {
  return window.WaveSurfer && window.WaveSurfer.Timeline;
}

/* ===================== WaveSurfer 初始化 ===================== */
function initWaveSurfer() {
  if (state.ws) {
    try { state.ws.destroy(); } catch(e) {}
    state.ws = null;
    state.wsRegions = null;
    state.activeRegion = null;
    // 清空容器，防止残留 canvas
    dom.waveformDiv.innerHTML = '';
    dom.timelineDiv.innerHTML = '';
  }

  const RegionsPlugin  = getRegionsPlugin();
  const TimelinePlugin = getTimelinePlugin();

  if (!RegionsPlugin || !TimelinePlugin) {
    console.warn('WaveSurfer 插件未就绪，跳过插件初始化');
  }

  const plugins = [];
  let regionsInst = null;

  if (RegionsPlugin) {
    regionsInst = RegionsPlugin.create();
    plugins.push(regionsInst);
  }
  if (TimelinePlugin) {
    plugins.push(TimelinePlugin.create({
      height: 22,
      primaryColor: '#6C63FF',
      secondaryColor: '#6C63FF',
      primaryFontColor: '#64748b',
      secondaryFontColor: '#64748b',
      style: 'font-size:11px; font-family: Segoe UI, sans-serif;',
    }));
  }

  state.ws = WaveSurfer.create({
    container:     dom.waveformDiv,
    waveColor:     ['#6C63FF', '#a855f7'],
    progressColor: ['#a855f7', '#ec4899'],
    cursorColor:   '#ffffff',
    cursorWidth:   2,
    barWidth:      2,
    barGap:        1,
    barRadius:     2,
    height:        120,
    normalize:     true,
    interact:      true,
    plugins,
  });

  state.wsRegions = regionsInst;

  /* ---- WaveSurfer 事件 ---- */
  state.ws.on('ready', () => {
    const dur = state.ws.getDuration();
    dom.timeTotal.textContent   = formatTime(dur);
    dom.timeCurrent.textContent = formatTime(0);
    updateExportInfo();

    // 开启鼠标拖拽创建选区（v7 必须在 ready 后调用）
    if (state.wsRegions) {
      state.wsRegions.enableDragSelection({
        color: 'rgba(108,99,255,0.25)',
      });
    }
  });

  state.ws.on('timeupdate', ct => {
    dom.timeCurrent.textContent = formatTime(ct);
  });

  state.ws.on('play',   () => { state.isPlaying = true;  syncPlayBtn(); });
  state.ws.on('pause',  () => { state.isPlaying = false; syncPlayBtn(); });
  state.ws.on('finish', () => { state.isPlaying = false; syncPlayBtn(); });

  /* ---- Regions 事件（v7）---- */
  if (regionsInst) {
    regionsInst.on('region-created', reg => {
      // 只保留一个选区：删除其他已有的
      const all = regionsInst.getRegions();
      // getRegions() 在 v7 返回数组
      const list = Array.isArray(all) ? all : Object.values(all);
      list.forEach(r => { if (r.id !== reg.id) r.remove(); });

      state.activeRegion = reg;
      syncRegionInputs(reg.start, reg.end);
      updateCutButtons(true);
    });

    regionsInst.on('region-updated', reg => {
      state.activeRegion = reg;
      syncRegionInputs(reg.start, reg.end);
    });

    regionsInst.on('region-removed', () => {
      // 检查是否还有剩余选区
      const all  = regionsInst.getRegions();
      const list = Array.isArray(all) ? all : Object.values(all);
      if (list.length === 0) {
        state.activeRegion = null;
        updateCutButtons(false);
        dom.regionStart.value = '';
        dom.regionEnd.value   = '';
      }
    });
  }
}

function syncPlayBtn() {
  dom.iconPlay.style.display  = state.isPlaying ? 'none' : '';
  dom.iconPause.style.display = state.isPlaying ? ''     : 'none';
}

function syncRegionInputs(start, end) {
  dom.regionStart.value = start.toFixed(3);
  dom.regionEnd.value   = end.toFixed(3);
}

function updateCutButtons(hasRegion) {
  dom.btnCut.disabled          = !hasRegion;
  dom.btnDeleteRegion.disabled = !hasRegion;
}

/* ===================== 加载音频到编辑器 ===================== */
async function loadTrackToEditor(track) {
  dom.waveformEmpty.style.display = 'none';
  dom.waveformDiv.style.display   = '';
  dom.timelineDiv.style.display   = '';
  dom.playbackBar.style.display   = '';
  dom.cutToolbar.style.display    = '';

  initWaveSurfer();

  try {
    // 用 Blob URL 加载，避免 CORS 和格式判断问题
    const mime = track.file.type || guessMime(track.name);
    const blob = new Blob([track.arrayBuffer], { type: mime });
    if (track.url) URL.revokeObjectURL(track.url);
    track.url = URL.createObjectURL(blob);

    await state.ws.load(track.url);

    // 同步解码为 AudioBuffer（供裁剪/导出使用）
    if (!track.audioBuffer) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      track.audioBuffer = await ctx.decodeAudioData(track.arrayBuffer.slice(0));
      track.duration    = track.audioBuffer.duration;
      await ctx.close();
    }

    state.activeTrackId = track.id;
    renderTrackList();
    updateExportInfo();
    dom.btnExport.disabled = false;
    showToast(`已加载：${track.name}`, 'success');
  } catch (err) {
    console.error('加载音频失败', err);
    showToast('加载失败：' + err.message, 'error');
  }
}

function guessMime(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return ({ mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg',
            flac:'audio/flac', aac:'audio/aac', m4a:'audio/mp4' })[ext] || 'audio/mpeg';
}

/* ===================== 导入音频 ===================== */
async function importFiles(files) {
  const arr = Array.from(files).filter(f =>
    f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(f.name));

  if (!arr.length) { showToast('不支持的文件格式', 'error'); return; }

  showToast('正在读取文件…', '', 5000);
  for (const file of arr) {
    const ab = await file.arrayBuffer();
    const track = {
      id: uid(), name: file.name, file,
      arrayBuffer: ab, audioBuffer: null, duration: null, url: null,
    };
    state.tracks.push(track);
  }

  dom.btnMerge.disabled = state.tracks.length < 2;
  renderTrackList();

  const latest = state.tracks[state.tracks.length - 1];
  await loadTrackToEditor(latest);
}

/* ===================== 渲染轨道列表 ===================== */
function renderTrackList() {
  dom.trackList.innerHTML = '';
  if (!state.tracks.length) {
    dom.trackList.innerHTML = '<li class="empty-hint">拖拽音频文件到此处，或点击「导入音频」</li>';
    return;
  }
  state.tracks.forEach(t => {
    const li = document.createElement('li');
    li.className = 'track-item' + (t.id === state.activeTrackId ? ' active' : '');

    const ext    = t.name.split('.').pop().toUpperCase();
    const durStr = t.duration ? formatTime(t.duration) : '—';

    li.innerHTML = `
      <div class="track-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <div class="track-info">
        <div class="track-name" title="${escHtml(t.name)}">${escHtml(t.name)}</div>
        <div class="track-meta">${ext} · ${durStr}</div>
      </div>
      <button class="track-del" title="移除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;

    li.querySelector('.track-del').addEventListener('click', e => {
      e.stopPropagation();
      removeTrack(t.id);
    });
    li.addEventListener('click', async () => {
      if (t.id !== state.activeTrackId) await loadTrackToEditor(t);
    });

    dom.trackList.appendChild(li);
  });
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function removeTrack(id) {
  state.tracks = state.tracks.filter(t => t.id !== id);
  dom.btnMerge.disabled = state.tracks.length < 2;

  if (state.activeTrackId === id) {
    state.activeTrackId = null;
    if (state.ws) { try { state.ws.destroy(); } catch(e){} state.ws = null; }
    if (state.tracks.length) {
      loadTrackToEditor(state.tracks[state.tracks.length - 1]);
    } else {
      dom.waveformDiv.innerHTML   = '';
      dom.waveformEmpty.style.display = '';
      dom.waveformDiv.style.display   = 'none';
      dom.timelineDiv.style.display   = 'none';
      dom.playbackBar.style.display   = 'none';
      dom.cutToolbar.style.display    = 'none';
      dom.btnExport.disabled = true;
    }
  }
  renderTrackList();
  showToast('已移除片段');
}

/* ===================== 播放控制 ===================== */
dom.btnPlay.addEventListener('click', () => {
  if (!state.ws) return;
  state.ws.playPause();
});

dom.btnSkipBack.addEventListener('click', () => {
  if (!state.ws) return;
  state.ws.setTime(0);
});

dom.btnSkipFwd.addEventListener('click', () => {
  if (!state.ws) return;
  state.ws.setTime(state.ws.getDuration());
});

dom.speedSelect.addEventListener('change', e => {
  if (state.ws) state.ws.setPlaybackRate(+e.target.value);
});

dom.volumeSlider.addEventListener('input', e => {
  if (state.ws) state.ws.setVolume(+e.target.value);
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) {
    e.preventDefault();
    if (state.ws) state.ws.playPause();
  }
});

/* ===================== 选区（精确输入） ===================== */
dom.btnSetRegion.addEventListener('click', () => {
  if (!state.ws || !state.wsRegions) return;
  const start = parseFloat(dom.regionStart.value);
  const end   = parseFloat(dom.regionEnd.value);
  const dur   = state.ws.getDuration();
  if (isNaN(start) || isNaN(end) || start < 0 || end > dur + 0.001 || start >= end) {
    showToast('请输入有效的时间范围', 'error'); return;
  }
  clearAllRegions();
  state.wsRegions.addRegion({
    start: Math.max(0, start),
    end:   Math.min(dur, end),
    color: 'rgba(108,99,255,0.30)',
    drag: true, resize: true,
  });
});

dom.btnClearRegion.addEventListener('click', () => {
  clearAllRegions();
  state.activeRegion = null;
  updateCutButtons(false);
  dom.regionStart.value = '';
  dom.regionEnd.value   = '';
});

function clearAllRegions() {
  if (!state.wsRegions) return;
  const all  = state.wsRegions.getRegions();
  const list = Array.isArray(all) ? all : Object.values(all);
  list.forEach(r => r.remove());
}

/* ===================== 裁剪逻辑 ===================== */
function sliceAudioBuffer(buffer, startSec, endSec) {
  const sr       = buffer.sampleRate;
  const ch       = buffer.numberOfChannels;
  const startSmp = Math.round(startSec * sr);
  const endSmp   = Math.min(Math.round(endSec * sr), buffer.length);
  const len      = endSmp - startSmp;
  if (len <= 0) return null;

  // OfflineAudioContext 仅用于创建 buffer，不需要 startRendering
  const tmp = new OfflineAudioContext(ch, len, sr);
  const out = tmp.createBuffer(ch, len, sr);
  for (let c = 0; c < ch; c++) {
    out.copyToChannel(buffer.getChannelData(c).slice(startSmp, endSmp), c);
  }
  return out;
}

function concatAudioBuffers(buffers) {
  if (!buffers.length) return null;
  const sr    = buffers[0].sampleRate;
  const ch    = buffers[0].numberOfChannels;
  const total = buffers.reduce((s, b) => s + b.length, 0);
  const tmp   = new OfflineAudioContext(ch, total, sr);
  const out   = tmp.createBuffer(ch, total, sr);
  let off = 0;
  for (const buf of buffers) {
    for (let c = 0; c < ch; c++) out.copyToChannel(buf.getChannelData(c), c, off);
    off += buf.length;
  }
  return out;
}

async function replaceActiveBuffer(newBuf, label) {
  const track = getActiveTrack();
  if (!track) return;
  const wav          = audioBufferToWav(newBuf, 16);
  track.arrayBuffer  = wav;
  track.audioBuffer  = newBuf;
  track.duration     = newBuf.duration;
  track.file         = new File([wav], track.name, { type: 'audio/wav' });
  await loadTrackToEditor(track);
  showToast(label, 'success');
}

function getActiveTrack() {
  return state.tracks.find(t => t.id === state.activeTrackId) || null;
}

dom.btnCut.addEventListener('click', async () => {
  const track = getActiveTrack();
  if (!track || !track.audioBuffer || !state.activeRegion) return;
  const { start, end } = state.activeRegion;
  const sliced = sliceAudioBuffer(track.audioBuffer, start, end);
  if (!sliced) { showToast('选区无效', 'error'); return; }
  await replaceActiveBuffer(sliced, `裁剪完成：${formatTime(start)} ~ ${formatTime(end)}`);
});

dom.btnDeleteRegion.addEventListener('click', async () => {
  const track = getActiveTrack();
  if (!track || !track.audioBuffer || !state.activeRegion) return;
  const { start, end } = state.activeRegion;
  const buf   = track.audioBuffer;
  const parts = [];
  if (start > 0.001)              parts.push(sliceAudioBuffer(buf, 0,   start));
  if (end   < buf.duration - 0.001) parts.push(sliceAudioBuffer(buf, end, buf.duration));
  if (!parts.length) { showToast('删除后音频为空', 'error'); return; }
  const merged = parts.length === 1 ? parts[0] : concatAudioBuffers(parts);
  if (!merged) { showToast('操作失败', 'error'); return; }
  await replaceActiveBuffer(merged, `已删除 ${formatTime(start)} ~ ${formatTime(end)}`);
});

/* ===================== 合并轨道 ===================== */
dom.btnMerge.addEventListener('click', async () => {
  if (state.tracks.length < 2) { showToast('至少需要 2 个音频片段', 'error'); return; }
  showToast('正在合并…', '', 10000);
  try {
    for (const t of state.tracks) {
      if (!t.audioBuffer) {
        const ctx    = new (window.AudioContext || window.webkitAudioContext)();
        t.audioBuffer = await ctx.decodeAudioData(t.arrayBuffer.slice(0));
        t.duration    = t.audioBuffer.duration;
        await ctx.close();
      }
    }
    const merged = concatAudioBuffers(state.tracks.map(t => t.audioBuffer));
    if (!merged) { showToast('合并失败', 'error'); return; }

    const names   = state.tracks.map(t => t.name.replace(/\.[^.]+$/, '')).join('+');
    const outName = (names.length > 40 ? names.slice(0,40)+'…' : names) + '_merged.wav';
    const wav     = audioBufferToWav(merged, 16);

    const mt = {
      id: uid(), name: outName,
      file: new File([wav], outName, { type: 'audio/wav' }),
      arrayBuffer: wav, audioBuffer: merged, duration: merged.duration, url: null,
    };
    state.tracks = [mt];
    dom.btnMerge.disabled = true;
    await loadTrackToEditor(mt);
    showToast('合并完成！', 'success');
  } catch(e) {
    console.error(e);
    showToast('合并出错：' + e.message, 'error');
  }
});

/* ===================== 导出对话框 ===================== */
dom.btnExport.addEventListener('click', () => {
  if (!getActiveTrack()) return;
  updateExportInfo();
  dom.exportModal.style.display     = 'flex';
  dom.exportProgress.style.display  = 'none';
  dom.progressFill.style.width      = '0%';
  dom.btnDoExport.disabled          = false;
});

dom.modalClose.addEventListener('click', () => { dom.exportModal.style.display = 'none'; });
dom.exportModal.addEventListener('click', e => {
  if (e.target === dom.exportModal) dom.exportModal.style.display = 'none';
});

dom.formatTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    dom.formatTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.exportFmt           = tab.dataset.fmt;
    dom.mp3Options.style.display = state.exportFmt === 'mp3' ? '' : 'none';
    dom.wavOptions.style.display = state.exportFmt === 'wav' ? '' : 'none';
    updateExportInfo();
  });
});

dom.mp3Bitrate.addEventListener('change', () => { state.exportBitrate  = +dom.mp3Bitrate.value;  updateExportInfo(); });
dom.wavBitdepth.addEventListener('change',() => { state.exportBitDepth = +dom.wavBitdepth.value; updateExportInfo(); });

function updateExportInfo() {
  const track = getActiveTrack();
  if (!track) return;
  const dur = track.duration || (state.ws ? state.ws.getDuration() : 0);
  dom.exportDuration.textContent = `时长：${formatTime(dur)}`;
  let est;
  if (state.exportFmt === 'mp3') {
    est = (state.exportBitrate * 1000 / 8) * dur;
  } else {
    const ch = track.audioBuffer ? track.audioBuffer.numberOfChannels : 2;
    const sr = track.audioBuffer ? track.audioBuffer.sampleRate : 44100;
    est = dur * ch * sr * (state.exportBitDepth / 8);
  }
  dom.exportSizeHint.textContent = `预估大小：${formatBytes(est)}`;
}

/* ===================== 导出执行 ===================== */
dom.btnDoExport.addEventListener('click', async () => {
  const track = getActiveTrack();
  if (!track || !track.audioBuffer) { showToast('没有可导出的音频', 'error'); return; }

  const filename = (dom.exportFilename.value.trim() || 'output') + '.' + state.exportFmt;
  dom.btnDoExport.disabled         = true;
  dom.exportProgress.style.display = 'flex';
  setProgress(5);

  try {
    let blob;
    if (state.exportFmt === 'wav') {
      dom.progressLabel.textContent = '编码 WAV…';
      setProgress(40);
      blob = new Blob([audioBufferToWav(track.audioBuffer, state.exportBitDepth)], { type: 'audio/wav' });
      setProgress(95);
    } else {
      dom.progressLabel.textContent = '加载 MP3 编码器…';
      setProgress(10);
      await loadLameJs();
      dom.progressLabel.textContent = 'MP3 编码中…';
      blob = await encodeMP3(track.audioBuffer, state.exportBitrate, setProgress);
    }
    setProgress(100);

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    setTimeout(() => {
      dom.exportModal.style.display    = 'none';
      dom.exportProgress.style.display = 'none';
      dom.btnDoExport.disabled         = false;
      showToast(`导出成功：${filename}`, 'success');
    }, 500);
  } catch(e) {
    console.error(e);
    dom.progressLabel.textContent = '导出失败：' + e.message;
    dom.btnDoExport.disabled = false;
    showToast('导出出错：' + e.message, 'error');
  }
});

function setProgress(pct) {
  dom.progressFill.style.width  = pct + '%';
  dom.progressLabel.textContent = pct < 100 ? `处理中 ${pct}%…` : '完成！';
}

/* ===================== WAV 编码器 ===================== */
function audioBufferToWav(buffer, bitDepth = 16) {
  const ch      = buffer.numberOfChannels;
  const sr      = buffer.sampleRate;
  const len     = buffer.length;
  const is32f   = bitDepth === 32;
  const bps     = bitDepth === 24 ? 3 : bitDepth === 32 ? 4 : 2;
  const dataSz  = len * ch * bps;
  const ab      = new ArrayBuffer(44 + dataSz);
  const v       = new DataView(ab);

  const ws = (o, s) => { for(let i=0;i<s.length;i++) v.setUint8(o+i, s.charCodeAt(i)); };
  const wu = (o, n) => v.setUint16(o, n, true);
  const wd = (o, n) => v.setUint32(o, n, true);

  ws(0,'RIFF'); wd(4, 36+dataSz); ws(8,'WAVE');
  ws(12,'fmt '); wd(16, 16);
  wu(20, is32f ? 3 : 1); wu(22, ch);
  wd(24, sr); wd(28, sr * ch * bps);
  wu(32, ch * bps); wu(34, bitDepth);
  ws(36,'data'); wd(40, dataSz);

  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const val = buffer.getChannelData(c)[i];
      if (is32f) {
        v.setFloat32(off, val, true); off += 4;
      } else if (bitDepth === 24) {
        const x = Math.max(-1, Math.min(1, val));
        const n = Math.round(x < 0 ? x * 8388608 : x * 8388607) & 0xFFFFFF;
        v.setUint8(off, n & 0xFF); v.setUint8(off+1, (n>>8)&0xFF); v.setUint8(off+2, (n>>16)&0xFF);
        off += 3;
      } else {
        const x = Math.max(-1, Math.min(1, val));
        v.setInt16(off, x < 0 ? x*32768 : x*32767, true); off += 2;
      }
    }
  }
  return ab;
}

/* ===================== MP3 编码 (lamejs CDN) ===================== */
let lameLoaded = false;
function loadLameJs() {
  if (lameLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src     = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
    s.onload  = () => { lameLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('无法加载 MP3 编码器，请检查网络'));
    document.head.appendChild(s);
  });
}

async function encodeMP3(audioBuffer, bitrate, onProgress) {
  const ch    = audioBuffer.numberOfChannels;
  const sr    = audioBuffer.sampleRate;
  const total = audioBuffer.length;
  const CHUNK = 1152;

  const enc     = new lamejs.Mp3Encoder(ch, sr, bitrate);
  const chunks  = [];
  const left16  = pcm32to16(audioBuffer.getChannelData(0));
  const right16 = ch > 1 ? pcm32to16(audioBuffer.getChannelData(1)) : left16;

  for (let i = 0; i < total; i += CHUNK) {
    const end = Math.min(i + CHUNK, total);
    const l   = left16.subarray(i, end);
    const r   = right16.subarray(i, end);
    const out = ch > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (out.length) chunks.push(new Int8Array(out));
    onProgress(20 + Math.round((end / total) * 70));
    if (i % (CHUNK * 128) === 0) await new Promise(r => setTimeout(r, 0));
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(new Int8Array(tail));
  return new Blob(chunks, { type: 'audio/mpeg' });
}

function pcm32to16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i]  = s < 0 ? s * 32768 : s * 32767;
  }
  return i16;
}

/* ===================== 拖拽上传 ===================== */
function setupDragDrop() {
  document.body.addEventListener('dragenter', e => {
    e.preventDefault();
    dom.dropZone.classList.add('dragover');
  });
  document.body.addEventListener('dragover',  e => e.preventDefault());
  document.body.addEventListener('dragleave', e => {
    if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) {
      dom.dropZone.classList.remove('dragover');
    }
  });
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });
}

/* ===================== 绑定按钮事件 ===================== */
dom.btnImport.addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', e => {
  if (e.target.files.length) { importFiles(e.target.files); e.target.value = ''; }
});

setupDragDrop();

/* ===================== 初始状态 ===================== */
dom.btnExport.disabled = true;
dom.btnMerge.disabled  = true;
updateCutButtons(false);
