// Scan de codes-barres et QR codes.
// 1) Détecteur natif du navigateur (BarcodeDetector, Chrome Android) : rapide et robuste.
// 2) Sinon ZXing (open source, Apache 2.0), chargé localement depuis /vendor : iPhone, Firefox…
import { eanValid } from './lookup.js';

const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_128', 'code_39'];

let zxingLoading;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  zxingLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing-0.21.3.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Bibliothèque de scan introuvable'));
    document.head.appendChild(s);
  });
  return zxingLoading;
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter(f => supported.includes(f));
    return formats.includes('ean_13') ? new BarcodeDetector({ formats }) : null;
  } catch { return null; }
}

// TRY_HARDER améliore la lecture d'une photo mais bloque le décodage vidéo continu.
function zxingReader(tryHarder = false) {
  const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = window.ZXing;
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  ]);
  if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, 120);
}

// Un code 1D n'est accepté que si sa clé de contrôle est bonne ET qu'il a été lu
// deux fois de suite à l'identique : évite les faux numéros sur jaquette abîmée.
function makeFilter(onCode) {
  let last = '', count = 0, done = false;
  return (text, isQr) => {
    if (done || !text) return;
    const digits = /^\d+$/.test(text);
    if (digits && /^(\d{8}|\d{12}|\d{13})$/.test(text) && !eanValid(text)) return;
    if (!isQr && digits) {
      count = text === last ? count + 1 : 1;
      last = text;
      if (count < 2) return;
    }
    done = true;
    navigator.vibrate?.(80);
    onCode(text);
  };
}

export async function startScan(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Caméra indisponible. Ouvrez l'appli en https (ou depuis l'écran d'accueil).");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const track = stream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}

  const accept = makeFilter(onCode);
  let stopped = false;
  let reader;

  const detector = await nativeDetector();
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();

  if (detector) {
    const loop = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          for (const c of codes) accept(c.rawValue.trim(), c.format === 'qr_code');
        }
      } catch {}
      setTimeout(loop, 120);
    };
    loop();
  } else {
    await loadZxing();
    reader = zxingReader();
    const QR = window.ZXing.BarcodeFormat.QR_CODE;
    reader.decodeFromStream(stream, video, (result) => {
      if (result && !stopped) accept(result.getText().trim(), result.getBarcodeFormat() === QR);
    });
  }

  const caps = track.getCapabilities?.() || {};
  let torchOn = false;
  return {
    engine: detector ? 'natif' : 'ZXing',
    hasTorch: !!caps.torch,
    async toggleTorch() {
      torchOn = !torchOn;
      try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
      return torchOn;
    },
    stop() {
      stopped = true;
      try { reader?.reset(); } catch {}
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    },
  };
}

// Plan B : décoder une photo prise avec l'appareil (souvent plus net en faible lumière).
export async function decodeImage(file) {
  const detector = await nativeDetector();
  if (detector) {
    const bmp = await createImageBitmap(file);
    const codes = await detector.detect(bmp);
    if (codes.length) return codes[0].rawValue.trim();
  }
  await loadZxing();
  const url = URL.createObjectURL(file);
  try {
    const res = await zxingReader(true).decodeFromImageUrl(url);
    return res.getText().trim();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
