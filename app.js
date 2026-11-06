const PDF_FILE = new URL('./Content/inklu_presentation.pdf', import.meta.url).href;
const PDFJS_MODULE = new URL('./node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url).href;
const PDFJS_WORKER = new URL('./node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
const PDFJS_FONTS = new URL('./node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href;

const IDLE_STORAGE_KEY = 'inklu.idleMs';
const DEFAULT_IDLE_MS = 2 * 60 * 1000;
const MIN_IDLE_MS = 15 * 1000;
const MAX_IDLE_MS = 10 * 60 * 1000;
const LAUNCHER_ZONE_PX = 96;

const video = document.querySelector('#intro-video');
const deck = document.querySelector('#deck');
const canvas = document.querySelector('#slide-canvas');
const deckStatus = document.querySelector('#deck-status');
const deckCounter = document.querySelector('#deck-counter');
const slideNumber = document.querySelector('#slide-number');
const slideTotal = document.querySelector('#slide-total');
const launcher = document.querySelector('#controls-launcher');
const openControlsButton = document.querySelector('#open-controls');
const dialog = document.querySelector('#controls');
const soundToggle = document.querySelector('#sound-toggle');
const idleRange = document.querySelector('#idle-range');
const idleOutput = document.querySelector('#idle-output');
const videoPlayButton = document.querySelector('#video-play');
const videoRestartButton = document.querySelector('#video-restart');
const slidePrevButton = document.querySelector('#slide-prev');
const slideNextButton = document.querySelector('#slide-next');
const backToVideoButton = document.querySelector('#back-to-video');
const fullscreenButton = document.querySelector('#fullscreen-toggle');
const modalSlide = document.querySelector('#modal-slide');

const state = {
  mode: 'video',
  slide: 0,
  total: 0,
  idleMs: readIdleMs(),
  userPaused: false,
  dialogOpen: false,
};

let idleTimer = null;
let launcherHideTimer = null;
let renderTask = null;
let renderSequence = 0;
let resizeTimer = null;
let pdfDocument = null;
let pdfDocumentPromise = null;
let pdfModulePromise = null;
let hasRenderedSlide = false;

/* ---------- Vídeo ---------- */

function playVideo() {
  const playback = video.play();
  if (playback) playback.catch(() => {});
}

video.muted = true;
soundToggle.checked = false;
playVideo();

if (video.readyState >= 2) schedulePdfPreload();
else video.addEventListener('loadeddata', schedulePdfPreload, { once: true });

function schedulePdfPreload() {
  setTimeout(() => {
    loadPdfDocument().catch(() => {});
  }, 1500);
}

video.addEventListener('click', () => {
  showDeck();
});

/* ---------- Alternância entre vídeo e apresentação ---------- */

async function showDeck() {
  if (state.mode === 'deck') return;

  state.mode = 'deck';
  video.pause();
  document.body.classList.add('is-presenting');
  deck.hidden = false;
  if (!hasRenderedSlide) {
    deckStatus.hidden = false;
    deckStatus.textContent = 'Carregando apresentação…';
  }
  syncControls();
  scheduleIdle();

  try {
    await loadPdfDocument();
  } catch (error) {
    console.error(error);
    if (state.mode === 'deck') {
      deckStatus.hidden = false;
      deckStatus.textContent = 'Não foi possível carregar a apresentação.';
    }
    return;
  }

  if (state.mode !== 'deck') return;
  showSlide(state.slide);
  syncSlideUI();
}

function showVideo() {
  if (state.mode === 'video') return;

  state.mode = 'video';
  clearIdleTimer();
  deck.hidden = true;
  document.body.classList.remove('is-presenting');
  if (dialog.open) dialog.close();

  if (!state.userPaused) playVideo();
  syncControls();
}

/* ---------- PDF ---------- */

function loadPdfModule() {
  pdfModulePromise ??= import(PDFJS_MODULE).then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return pdfjs;
  });
  return pdfModulePromise;
}

function loadPdfDocument() {
  pdfDocumentPromise ??= loadPdfModule()
    .then((pdfjs) =>
      pdfjs.getDocument({ url: PDF_FILE, standardFontDataUrl: PDFJS_FONTS }).promise,
    )
    .then((document) => {
      pdfDocument = document;
      state.total = document.numPages;
      slideTotal.textContent = String(document.numPages);
      syncSlideUI();
      return document;
    })
    .catch((error) => {
      pdfDocumentPromise = null;
      throw error;
    });
  return pdfDocumentPromise;
}

async function showSlide(index) {
  if (!pdfDocument || state.mode !== 'deck') return;

  const target = Math.max(0, Math.min(index, state.total - 1));
  state.slide = target;
  syncSlideUI();

  const sequence = ++renderSequence;

  try {
    const page = await pdfDocument.getPage(target + 1);
    if (sequence !== renderSequence || state.mode !== 'deck') return;

    if (renderTask) {
      renderTask.cancel();
      try {
        await renderTask.promise;
      } catch {
        /* renderização cancelada */
      }
      renderTask = null;
    }
    if (sequence !== renderSequence || state.mode !== 'deck') return;

    const baseViewport = page.getViewport({ scale: 1 });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const fitScale = Math.min(
      window.innerWidth / baseViewport.width,
      window.innerHeight / baseViewport.height,
    );
    const viewport = page.getViewport({ scale: fitScale * pixelRatio });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${Math.floor(baseViewport.width * fitScale)}px`;
    canvas.style.height = `${Math.floor(baseViewport.height * fitScale)}px`;

    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);

    renderTask = page.render({ canvas, canvasContext: context, viewport });
    await renderTask.promise;
    renderTask = null;

    if (sequence === renderSequence) {
      hasRenderedSlide = true;
      deckStatus.hidden = true;
      deckStatus.textContent = '';
    }
  } catch (error) {
    if (error && error.name === 'RenderingCancelledException') return;
    console.error(error);
    if (sequence === renderSequence) {
      deckStatus.hidden = false;
      deckStatus.textContent = 'Não foi possível exibir este slide.';
    }
  }
}

async function step(delta) {
  if (state.mode === 'video') await showDeck();
  if (!pdfDocument) return;

  const target = state.slide + delta;
  if (target >= 0 && target < state.total) showSlide(target);
}

/* ---------- Interface / controles ---------- */

function syncSlideUI() {
  const current = state.total ? state.slide + 1 : 1;
  slideNumber.textContent = String(current);
  modalSlide.textContent = state.total ? `${current} de ${state.total}` : '–';
  deckCounter.hidden = !state.total;
  slidePrevButton.disabled = !state.total || state.slide === 0;
  slideNextButton.disabled = !state.total || state.slide >= state.total - 1;
}

function syncControls() {
  soundToggle.checked = !video.muted;
  idleRange.value = String(state.idleMs / 1000);
  idleOutput.textContent = formatIdle(state.idleMs);
  videoPlayButton.textContent = state.userPaused ? 'Retomar vídeo' : 'Pausar vídeo';
  fullscreenButton.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  syncSlideUI();
}

function openControls() {
  if (dialog.open) return;
  syncControls();
  revealLauncher();
  clearIdleTimer();
  state.dialogOpen = true;
  dialog.showModal();
}

function revealLauncher() {
  clearTimeout(launcherHideTimer);
  launcher.classList.add('is-visible');
}

function hideLauncherSoon() {
  if (state.dialogOpen) return;
  clearTimeout(launcherHideTimer);
  launcherHideTimer = setTimeout(() => {
    if (!state.dialogOpen && !launcher.matches(':hover')) {
      launcher.classList.remove('is-visible');
    }
  }, 400);
}

function onPointerMove(event) {
  const nearBottom = event.clientY >= window.innerHeight - LAUNCHER_ZONE_PX;
  if (nearBottom) {
    revealLauncher();
  } else if (!(event.target instanceof Element && launcher.contains(event.target))) {
    hideLauncherSoon();
  }
  handleActivity();
}

/* ---------- Tempo ocioso ---------- */

function handleActivity() {
  if (state.mode === 'deck' && !state.dialogOpen) scheduleIdle();
}

function scheduleIdle() {
  clearIdleTimer();
  if (state.mode !== 'deck' || state.dialogOpen || !state.idleMs) return;

  idleTimer = setTimeout(() => {
    idleTimer = null;
    showVideo();
  }, state.idleMs);
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function readIdleMs() {
  try {
    const stored = Number(localStorage.getItem(IDLE_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= MIN_IDLE_MS && stored <= MAX_IDLE_MS) {
      return stored;
    }
  } catch {
    /* armazenamento indisponível */
  }
  return DEFAULT_IDLE_MS;
}

function formatIdle(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} min ${remainder} s` : `${minutes} min`;
}

/* ---------- Teclado ---------- */

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.key === 'a' || event.key === 'A') {
    event.preventDefault();
    showVideo();
    return;
  }

  if (dialog.open) return;
  if (event.key === 'Escape' || event.key === 'Tab' || /^F\d+$/.test(event.key)) return;

  if (state.mode === 'video') {
    event.preventDefault();
    showDeck();
    return;
  }

  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
    case ' ':
    case 'Spacebar':
    case 'Enter':
      event.preventDefault();
      step(1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
    case 'Backspace':
      event.preventDefault();
      step(-1);
      break;
    case 'Home':
      event.preventDefault();
      if (pdfDocument) showSlide(0);
      break;
    case 'End':
      event.preventDefault();
      if (pdfDocument) showSlide(state.total - 1);
      break;
    default:
      break;
  }

  scheduleIdle();
}

/* ---------- Cliques nos slides ---------- */

function onDeckClick(event) {
  if (state.mode !== 'deck' || !pdfDocument) return;
  const goingBack = event.clientX < window.innerWidth * 0.3;
  step(goingBack ? -1 : 1);
}

/* ---------- Eventos ---------- */

openControlsButton.addEventListener('click', openControls);
videoPlayButton.addEventListener('click', () => {
  if (state.mode === 'video') {
    if (video.paused) {
      state.userPaused = false;
      playVideo();
    } else {
      state.userPaused = true;
      video.pause();
    }
  } else {
    state.userPaused = !state.userPaused;
  }
  syncControls();
});

videoRestartButton.addEventListener('click', () => {
  video.currentTime = 0;
  state.userPaused = false;
  if (state.mode === 'video') playVideo();
  syncControls();
});

slidePrevButton.addEventListener('click', () => step(-1));
slideNextButton.addEventListener('click', () => step(1));
backToVideoButton.addEventListener('click', showVideo);

fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (error) {
    console.warn('Tela cheia indisponível:', error);
  }
  syncControls();
});

soundToggle.addEventListener('change', () => {
  video.muted = !soundToggle.checked;
  if (!video.muted && state.mode === 'video' && !state.userPaused && video.paused) {
    playVideo();
  }
  syncControls();
});

idleRange.addEventListener('input', () => {
  state.idleMs = Number(idleRange.value) * 1000;
  idleOutput.textContent = formatIdle(state.idleMs);
  try {
    localStorage.setItem(IDLE_STORAGE_KEY, String(state.idleMs));
  } catch {
    /* armazenamento indisponível */
  }
  scheduleIdle();
});

dialog.addEventListener('close', () => {
  state.dialogOpen = false;
  scheduleIdle();
});

dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  const inside =
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom;
  if (!inside) dialog.close();
});

document.addEventListener('fullscreenchange', syncControls);

window.addEventListener('pointermove', onPointerMove, { passive: true });
window.addEventListener('pointerdown', handleActivity, { passive: true });
window.addEventListener('keydown', onKeyDown);
deck.addEventListener('click', onDeckClick);

window.addEventListener('resize', () => {
  if (state.mode !== 'deck' || !pdfDocument) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.mode === 'deck' && pdfDocument) showSlide(state.slide);
  }, 150);
});

syncControls();
