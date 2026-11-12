/* foodie · camera access. A thin, testable layer over getUserMedia: it opens the rear camera, says in plain terms why it could not,
   and always lets go of the hardware (every track stopped) when asked. Nothing is recorded and nothing leaves the device here. */

/** @typedef {'denied'|'none'|'busy'|'unsupported'|'unknown'} CameraProblem */

/** Why getUserMedia failed, in terms the UI can act on. */
export function classifyCameraError(e) {
  const name = e && typeof e.name === 'string' ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'none';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'unknown';
}

/** True when this browser can ask for a camera at all (it cannot on plain http, or in very old browsers). */
export const cameraSupported = (mediaDevices) => !!(mediaDevices && typeof mediaDevices.getUserMedia === 'function');

/**
 * Opens the rear camera ("ideal", so a laptop webcam still works).
 * @param {MediaDevices|undefined} mediaDevices  navigator.mediaDevices
 * @returns {Promise<{ok:true, stream:MediaStream}|{ok:false, problem:CameraProblem}>}
 */
export async function openCamera(mediaDevices) {
  if (!cameraSupported(mediaDevices)) return { ok: false, problem: 'unsupported' };
  const attempts = [
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
    { video: true, audio: false },                      // a device that rejects the constraints above still has a camera
  ];
  let last = null;
  for (const constraints of attempts) {
    try {
      return { ok: true, stream: await mediaDevices.getUserMedia(constraints) };
    } catch (e) {
      last = e;
      const problem = classifyCameraError(e);
      if (problem === 'denied' || problem === 'busy') break;     // asking again would not change the answer
    }
  }
  return { ok: false, problem: classifyCameraError(last) };
}

/** Lets go of the camera: every track stopped, so the indicator light goes out. Safe to call twice, or with nothing. */
export function stopStream(stream) {
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) { try { track.stop(); } catch (e) { /* already stopped */ } }
}

/** Shows a stream in a <video>. `muted` and `playsinline` are what lets iOS play it without a gesture. */
export async function attachStream(video, stream) {
  video.muted = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* autoplay is allowed for muted video; if it still fails the first frame shows anyway */ }
}
