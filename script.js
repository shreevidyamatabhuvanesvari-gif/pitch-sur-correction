'use strict';

const $ = id => document.getElementById(id);
const video = $('video');
const fileInput = $('file');
const chooseBtn = $('choose');
const playBtn = $('play');
const stopBtn = $('stop');
const fullBtn = $('full');
const downloadBtn = $('download');
const stage = $('stage');
const empty = $('empty');
const fileName = $('fileName');
const status = $('status');
const dot = $('dot');
const progress = $('progress');
const modes = [...document.querySelectorAll('.mode')];

const MODE = {
  light: { depth: 0.34, speed: 0.045 },
  medium: { depth: 0.70, speed: 0.16 },
  strong: { depth: 1.00, speed: 0.42 }
};

const STATE = {
  EMPTY: 'EMPTY',
  LOADING: 'LOADING',
  READY: 'READY',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
  ENDED: 'ENDED',
  PREPARING_EXPORT: 'PREPARING_EXPORT',
  EXPORTING: 'EXPORTING',
  FINALIZING: 'FINALIZING',
  DONE: 'DONE',
  ERROR: 'ERROR'
};

let appState = STATE.EMPTY;
let mode = 'medium';
let objectUrl = '';
let exportUrl = '';
let exportBusy = false;
let exportAbort = false;
let ctx = null;
let source = null;
let processor = null;
let exportDestination = null;
let audioReady = false;
let workletLoaded = false;
let selectedFile = null;
let canvas = null;
let canvasCtx = null;
let canvasStream = null;
let canvasFrameId = 0;
let canvasRafId = 0;
let progressRafId = 0;
let exportRecorder = null;
let exportVideoStream = null;
let exportCombinedStream = null;

function setState(next) {
  appState = next;
  const hasVideo = !!video.src && video.readyState >= 1;
  const busy = exportBusy;
  playBtn.disabled = !hasVideo || busy;
  stopBtn.disabled = !hasVideo || busy;
  fullBtn.disabled = !hasVideo || busy || !document.fullscreenEnabled;
  downloadBtn.disabled = !hasVideo || busy;
  chooseBtn.disabled = busy;
  fileInput.disabled = busy;
  modes.forEach(button => button.disabled = busy);
  video.controls = !busy;
}

function say(message, kind = 'normal') {
  status.textContent = message;
  dot.classList.toggle('ok', kind === 'ok');
  dot.classList.toggle('bad', kind === 'bad');
}

function modeName() {
  return mode[0].toUpperCase() + mode.slice(1);
}

function setMode(next) {
  if (!MODE[next]) return;
  mode = next;
  modes.forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
  if (processor) processor.port.postMessage({ type: 'strength', value: MODE[mode] });
  if (!exportBusy && video.paused) say(`Correction: ${modeName()}`);
}

function resetProcessor() {
  if (processor) processor.port.postMessage({ type: 'reset' });
}

function fail(message) {
  setState(STATE.ERROR);
  say(message, 'bad');
  progress.style.width = '0%';
}

function requireAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is not available in this browser.');
  if (!ctx) ctx = new AudioContextClass();
  if (!ctx.audioWorklet) throw new Error('AudioWorklet is not available in this browser.');
  return ctx;
}

async function setupAudio() {
  const audio = requireAudioContext();
  if (audioReady && processor && exportDestination) {
    processor.port.postMessage({ type: 'strength', value: MODE[mode] });
    return;
  }
  if (!video.src) throw new Error('Please select a video first.');
  say('Preparing audio processor...');
  if (!workletLoaded) {
    try {
      await audio.audioWorklet.addModule('pitch-processor.js');
      workletLoaded = true;
    } catch (error) {
      console.error(error);
      throw new Error('Pitch processor could not be loaded.');
    }
  }
  try {
    source = source || audio.createMediaElementSource(video);
    try {
      processor = new AudioWorkletNode(audio, 'pitch-corrector', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
    } catch {
      processor = new AudioWorkletNode(audio, 'pitch-corrector', {
        numberOfInputs: 1,
        numberOfOutputs: 1
      });
    }
  } catch (error) {
    console.error(error);
    throw new Error('Pitch processing could not be initialized.');
  }
  try {
    exportDestination = audio.createMediaStreamDestination();
    source.connect(processor);
    processor.connect(audio.destination);
    processor.connect(exportDestination);
  } catch (error) {
    console.error(error);
    try { processor.disconnect(); } catch {}
    throw new Error('Audio routing could not be initialized.');
  }
  processor.port.postMessage({ type: 'strength', value: MODE[mode] });
  processor.port.postMessage({ type: 'reset' });
  audioReady = true;
}

function cleanupFileUrl() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }
}

function cleanupExportUrl() {
  if (exportUrl) {
    URL.revokeObjectURL(exportUrl);
    exportUrl = '';
  }
}

function clearExportCapture() {
  if (canvasFrameId && 'cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
    try { video.cancelVideoFrameCallback(canvasFrameId); } catch {}
  }
  canvasFrameId = 0;
  if (canvasRafId) cancelAnimationFrame(canvasRafId);
  canvasRafId = 0;
  if (exportVideoStream) exportVideoStream.getVideoTracks().forEach(track => track.stop());
  if (canvasStream && canvasStream !== exportVideoStream) canvasStream.getTracks().forEach(track => track.stop());
  exportVideoStream = null;
  canvasStream = null;
  exportCombinedStream = null;
  canvas = null;
  canvasCtx = null;
}

function sanitizeBaseName(name) {
  const base = String(name || 'corrected-video').replace(/\.[^.]+$/, '');
  return base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'corrected-video';
}

function supportedMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return null;
  const candidates = [
    ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'mp4'],
    ['video/mp4;codecs="avc1.4D401E,mp4a.40.2"', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs="vp9,opus"', 'webm'],
    ['video/webm;codecs="vp8,opus"', 'webm'],
    ['video/webm', 'webm']
  ];
  return candidates.find(item => {
    try { return MediaRecorder.isTypeSupported(item[0]); } catch { return false; }
  }) || null;
}

function waitForEvent(target, event, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const onEvent = value => {
      clearTimeout(timer);
      resolve(value);
    };
    target.addEventListener(event, onEvent, { once: true });
    timer = setTimeout(() => {
      target.removeEventListener(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, timeout);
  });
}

async function seekToStart() {
  if (Math.abs(video.currentTime) < 0.02) {
    video.currentTime = 0;
    return;
  }
  video.currentTime = 0;
  await waitForEvent(video, 'seeked', 10000);
}

function drawCanvasFrame() {
  if (!canvasCtx || !canvas) return;
  try {
    canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const track = canvasStream?.getVideoTracks()[0];
    if (track?.requestFrame) track.requestFrame();
  } catch (error) {
    console.error(error);
  }
}

function startCanvasCapture() {
  if (!video.videoWidth || !video.videoHeight) throw new Error('Video dimensions are unavailable.');
  if (!HTMLCanvasElement.prototype.captureStream) throw new Error('Video export is not supported by this browser.');
  canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvasCtx = canvas.getContext('2d', { alpha: false });
  if (!canvasCtx) throw new Error('Canvas video capture is unavailable.');
  drawCanvasFrame();
  canvasStream = canvas.captureStream();
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const paint = () => {
      if (!exportBusy) return;
      drawCanvasFrame();
      canvasFrameId = video.requestVideoFrameCallback(paint);
    };
    canvasFrameId = video.requestVideoFrameCallback(paint);
  } else {
    const paint = () => {
      if (!exportBusy) return;
      drawCanvasFrame();
      canvasRafId = requestAnimationFrame(paint);
    };
    canvasRafId = requestAnimationFrame(paint);
  }
  return canvasStream;
}

function captureVideoTracks() {
  if (typeof video.captureStream === 'function') {
    try {
      exportVideoStream = video.captureStream();
      const videoTracks = exportVideoStream.getVideoTracks();
      exportVideoStream.getAudioTracks().forEach(track => track.stop());
      if (videoTracks.length) return videoTracks;
    } catch (error) {
      console.warn('video.captureStream failed', error);
    }
    clearExportCapture();
  }
  exportVideoStream = startCanvasCapture();
  const tracks = exportVideoStream.getVideoTracks();
  if (!tracks.length) throw new Error('Video capture is not supported by this browser.');
  return tracks;
}

function buildExportStream() {
  if (!exportDestination) throw new Error('Processed audio export is unavailable.');
  const videoTracks = captureVideoTracks();
  const audioTracks = exportDestination.stream.getAudioTracks();
  if (!audioTracks.length) throw new Error('Processed audio export is unavailable.');
  exportCombinedStream = new MediaStream([...videoTracks, audioTracks[0]]);
  return exportCombinedStream;
}

function makeRecorder(stream, mime) {
  try {
    return new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 5000000,
      audioBitsPerSecond: 128000
    });
  } catch (firstError) {
    console.warn('Recorder bitrate options rejected', firstError);
    try {
      return new MediaRecorder(stream, { mimeType: mime });
    } catch (secondError) {
      console.error(secondError);
      throw new Error('Video export could not be initialized.');
    }
  }
}

function waitForRecorderStop(recorder, chunks) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    recorder.addEventListener('stop', () => finish(), { once: true });
    recorder.addEventListener('error', event => {
      const message = event?.error?.message || 'MediaRecorder error.';
      finish(new Error(message));
    }, { once: true });
    recorder.addEventListener('dataavailable', event => {
      if (event.data && event.data.size) chunks.push(event.data);
    });
  });
}

function startProgress() {
  if (progressRafId) cancelAnimationFrame(progressRafId);
  const tick = () => {
    if (!exportBusy) return;
    const duration = video.duration;
    if (Number.isFinite(duration) && duration > 0) {
      const value = Math.max(0, Math.min(100, video.currentTime / duration * 100));
      progress.style.width = `${value.toFixed(2)}%`;
    }
    progressRafId = requestAnimationFrame(tick);
  };
  progressRafId = requestAnimationFrame(tick);
}

function stopProgress() {
  if (progressRafId) cancelAnimationFrame(progressRafId);
  progressRafId = 0;
}

async function playVideo() {
  if (!video.src) {
    fail('Please select a video first.');
    return;
  }
  if (exportBusy) return;
  try {
    setState(STATE.LOADING);
    await setupAudio();
    if (ctx.state === 'suspended') await ctx.resume();
    resetProcessor();
    if (video.ended) video.currentTime = 0;
    video.playbackRate = 1;
    processor.port.postMessage({ type: 'strength', value: MODE[mode] });
    await video.play();
    setState(STATE.PLAYING);
    say(`Pitch correction active — ${modeName()}`, 'ok');
  } catch (error) {
    console.error(error);
    fail(error?.message || 'Playback could not start.');
  }
}

function stopVideo() {
  if (!video.src || exportBusy) return;
  video.pause();
  video.currentTime = 0;
  video.playbackRate = 1;
  resetProcessor();
  setState(STATE.STOPPED);
  say('Stopped — ready to play');
  progress.style.width = '0%';
}

async function toggleFullscreen() {
  if (!video.src) {
    fail('Please select a video first.');
    return;
  }
  if (!document.fullscreenEnabled) {
    fail('Full Screen is not available in this browser.');
    return;
  }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen();
  } catch (error) {
    console.error(error);
    fail('Full Screen is not available in this browser.');
  }
}

async function startExport() {
  if (exportBusy) return;
  if (!video.src || !selectedFile) {
    fail('Please select a video first.');
    return;
  }
  if (!video.duration || video.readyState < 2) {
    fail('This video is not ready for export.');
    return;
  }
  if (!window.MediaRecorder || !window.MediaStream) {
    fail('Video export is not supported by this browser.');
    return;
  }
  const format = supportedMime();
  if (!format) {
    fail('No supported export format is available.');
    return;
  }
  exportBusy = true;
  exportAbort = false;
  setState(STATE.PREPARING_EXPORT);
  progress.style.width = '0%';
  cleanupExportUrl();
  clearExportCapture();
  say('Preparing export...');
  try {
    await setupAudio();
    if (ctx.state === 'suspended') await ctx.resume();
    resetProcessor();
    video.pause();
    await seekToStart();
    say('Checking browser support...');
    const stream = buildExportStream();
    if (!stream.getVideoTracks().length || !stream.getAudioTracks().length) {
      throw new Error('Video export could not create the required media tracks.');
    }
    exportRecorder = makeRecorder(stream, format[0]);
    const chunks = [];
    const recorderStopped = waitForRecorderStop(exportRecorder, chunks);
    exportRecorder.start(1000);
    setState(STATE.EXPORTING);
    say(`Exporting... ${modeName()}`, 'ok');
    startProgress();
    resetProcessor();
    video.currentTime = 0;
    await new Promise(requestAnimationFrame);
    await video.play();
    await new Promise((resolve, reject) => {
      const onEnded = () => {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        video.removeEventListener('ended', onEnded);
        reject(new Error('Video playback failed during export.'));
      };
      video.addEventListener('ended', onEnded);
      video.addEventListener('error', onError, { once: true });
    });
    setState(STATE.FINALIZING);
    say('Finalizing...');
    if (exportRecorder.state !== 'inactive') exportRecorder.stop();
    await recorderStopped;
    if (!chunks.length) throw new Error('Export produced no media data.');
    const blob = new Blob(chunks, { type: format[0].split(';', 1)[0] });
    if (!blob.size) throw new Error('Export produced an empty file.');
    exportUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = exportUrl;
    link.download = `${sanitizeBaseName(selectedFile.name)}-pitch-corrected.${format[1]}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    progress.style.width = '100%';
    say(`Download ready — ${format[1].toUpperCase()}`, 'ok');
  } catch (error) {
    console.error(error);
    if (exportRecorder && exportRecorder.state !== 'inactive') {
      try { exportRecorder.stop(); } catch {}
    }
    if (exportAbort) say('Export cancelled.');
    else say(error?.message || 'Export failed.', 'bad');
  } finally {
    exportBusy = false;
    stopProgress();
    clearExportCapture();
    exportRecorder = null;
    video.playbackRate = 1;
    if (video.src) {
      if (video.ended) setState(STATE.ENDED);
      else if (video.paused) setState(STATE.READY);
      else setState(STATE.PLAYING);
    } else {
      setState(STATE.EMPTY);
    }
  }
}

function handleFile(file) {
  if (!file || exportBusy) return;
  if (file.type && !file.type.startsWith('video/')) {
    fileInput.value = '';
    fail('Please choose a video file.');
    return;
  }
  exportAbort = true;
  cleanupExportUrl();
  clearExportCapture();
  cleanupFileUrl();
  selectedFile = file;
  objectUrl = URL.createObjectURL(file);
  video.pause();
  video.removeAttribute('src');
  video.load();
  audioReady = !!processor;
  resetProcessor();
  fileName.textContent = file.name;
  empty.style.display = 'grid';
  progress.style.width = '0%';
  setState(STATE.LOADING);
  say('Loading video...');
  video.src = objectUrl;
  video.load();
}

function handleLoadedMetadata() {
  empty.style.display = 'none';
  video.playbackRate = 1;
  setState(STATE.READY);
  say(`Video ready • ${formatTime(video.duration)} • Correction: ${modeName()}`);
}

function handleVideoError() {
  empty.style.display = 'grid';
  fail('This video could not be played in this browser.');
}

function handlePause() {
  if (exportBusy || video.ended || !video.src || appState === STATE.STOPPED) return;
  if (video.currentTime > 0) {
    setState(STATE.PAUSED);
    say('Paused');
  }
}

function handlePlay() {
  if (exportBusy) return;
  video.playbackRate = 1;
  setState(STATE.PLAYING);
  say(`Pitch correction active — ${modeName()}`, 'ok');
}

function handleEnded() {
  if (exportBusy) return;
  resetProcessor();
  setState(STATE.ENDED);
  say('Video ended — press Play to replay');
  progress.style.width = '100%';
}

function handleSeeking() {
  if (exportBusy) return;
  resetProcessor();
  video.playbackRate = 1;
}

function handleRateChange() {
  if (video.playbackRate !== 1) video.playbackRate = 1;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function init() {
  modes.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
  chooseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));
  playBtn.addEventListener('click', playVideo);
  stopBtn.addEventListener('click', stopVideo);
  fullBtn.addEventListener('click', toggleFullscreen);
  downloadBtn.addEventListener('click', startExport);
  video.addEventListener('loadedmetadata', handleLoadedMetadata);
  video.addEventListener('error', handleVideoError);
  video.addEventListener('pause', handlePause);
  video.addEventListener('play', handlePlay);
  video.addEventListener('ended', handleEnded);
  video.addEventListener('seeking', handleSeeking);
  video.addEventListener('ratechange', handleRateChange);
  video.addEventListener('emptied', () => {
    if (!exportBusy) setState(video.src ? STATE.LOADING : STATE.EMPTY);
  });
  document.addEventListener('fullscreenchange', () => setState(appState));
  setMode('medium');
  setState(STATE.EMPTY);
}

window.addEventListener('beforeunload', () => {
  exportAbort = true;
  cleanupExportUrl();
  clearExportCapture();
  cleanupFileUrl();
  try { video.pause(); } catch {}
  if (ctx) {
    try { ctx.close(); } catch {}
  }
});

init();
