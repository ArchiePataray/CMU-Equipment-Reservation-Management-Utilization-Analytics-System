/* QR presentation, explicit member submissions, image decoding and office scanning.
   Submissions use the same browser storage as the existing reservation records. */
let qrReader = null, qrReadGeneration = 0;
Object.assign(CLS, { RECEIVED: 'y', VIEWED: 'b', VERIFIED: 'g' });

function reservationQrImage(payload) {
  const host = document.createElement('div');
  new QRCode(host, { text: payload, width: 420, height: 420, correctLevel: QRCode.CorrectLevel.M });
  const source = host.querySelector('canvas');
  if (!source) throw new Error('QR image generation is unavailable.');
  // A white quiet zone keeps saved images and screenshots readable by scanners.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 484;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, 484, 484);
  context.drawImage(source, 32, 32);
  return canvas.toDataURL('image/png');
}

function currentQrSubmission(r) {
  return db.qrSubmissions.find(s => s.rid === r.id && s.uid === r.uid && s.payload === qrText(r));
}
function qrSubmissionState(s) {
  const r = res(s.rid);
  if (!r) return 'Unavailable';
  if (r.status !== 'APPROVED') return r.status;
  if (!r.qr || s.payload !== qrText(r)) return 'Expired';
  return s.verifiedAt ? 'Verified' : s.viewedAt ? 'Viewed' : 'Received';
}
function qrSubmissionSummary(s) {
  if (!s) return '';
  return `<p class="note">Sent to the admin inbox ${dt(s.sentAt)}. Status: ${badge(qrSubmissionState(s))}${s.verifiedAt ? `<br>Verified by the office ${dt(s.verifiedAt)}. Equipment release still requires the administrator's confirmation.` : ''}</p>`;
}
function openReservationQR(id) {
  const r = res(id);
  if (!canViewReservation(r) || r.status !== 'APPROVED' || !r.qr) return toast('A QR code is available only for your approved reservation.', true);
  let image;
  try { image = reservationQrImage(qrText(r)); }
  catch (error) { return toast(error.message, true); }
  const member = me().role === 'user', sent = currentQrSubmission(r);
  modal(`<h3>Reservation QR Code</h3><div class="qr qr-image"><img id="qrc" src="${image}" alt="QR code for reservation ${esc(r.id)}" width="484" height="484"></div><label for="qr-reservation-id">Reservation ID</label><div class="pwrow"><input id="qr-reservation-id" value="${esc(r.id)}" readonly><button class="btn ghost" data-a="copyReservationId" data-id="${esc(r.id)}">Copy ID</button></div><div class="ft"><button class="btn ghost" data-a="downloadReservationQr" data-id="${esc(r.id)}">Download QR</button>${member ? `<button class="btn" data-a="sendReservationQr" data-id="${esc(r.id)}" ${sent ? 'disabled' : ''}>${sent ? 'QR Sent to Admin' : 'Send QR to Admin'}</button>` : ''}</div>${member ? qrSubmissionSummary(sent) + '<p class="hint">The admin inbox is shared by accounts using this browser. It does not send to another device.</p>' : ''}${dl({ Name: esc(usr(r.uid).name), Date: D(r.date), Time: `${T(r.s)} - ${T(r.e)}`, Equipment: itemsText(r.items), Status: badge(r.status) })}<ol class="qr-options"><li>Visit the equipment office and present this QR for scanning.</li><li>Give the administrator your reservation ID instead.</li><li>Send this QR to the admin inbox, or download it to share a copy.</li></ol>`);
}

A.copyReservationId = async function(d) {
  const r = res(d.id);
  if (!canViewReservation(r) || !r.qr) return toast('Reservation unavailable.', true);
  try { await navigator.clipboard.writeText(r.id); toast('Reservation ID copied.'); }
  catch {
    const input = $('#qr-reservation-id');
    if (input) { input.focus(); input.select(); }
    toast('Select and copy the displayed reservation ID.');
  }
};
A.downloadReservationQr = function(d) {
  const submission = d.submission ? db.qrSubmissions.find(s => s.id === d.submission) : null;
  const r = res(submission ? submission.rid : d.id);
  if (!canViewReservation(r) || (submission && me().role !== 'admin') || (!submission && (r.status !== 'APPROVED' || !r.qr))) return toast('This QR is unavailable to your account.', true);
  try {
    const link = document.createElement('a');
    link.href = submission ? submission.image : reservationQrImage(qrText(r));
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(link.href)) throw new Error('The saved QR image could not be read.');
    link.download = `CMU-${r.id}-QR.png`; document.body.appendChild(link); link.click(); link.remove();
    toast('QR image download started.');
  } catch (error) { toast(error.message, true); }
};
A.sendReservationQr = function(d) {
  const r = res(d.id);
  if (!me() || me().role !== 'user' || !me().active || !r || r.uid !== sess || r.status !== 'APPROVED' || !r.qr) return toast('You can send only your own approved reservation QR.', true);
  if (currentQrSubmission(r)) return toast('This QR has already been sent to the admin inbox.');
  let image;
  try { image = reservationQrImage(qrText(r)); }
  catch (error) { return toast(error.message, true); }
  const submission = { id: 'QRS-' + crypto.randomUUID(), rid: r.id, uid: sess, payload: qrText(r), image, sentAt: new Date().toISOString(), viewedAt: '', viewedBy: '', verifiedAt: '', verifiedBy: '' };
  const previousNotes = db.notes.slice();
  db.qrSubmissions.unshift(submission);
  notifyAdmins(`${me().name} sent the QR for reservation ${r.id}. Open the received QR to view or download it.`, 'qr-sent-' + submission.id, { qrSubmissionId: submission.id });
  if (!save()) { db.qrSubmissions = db.qrSubmissions.filter(s => s.id !== submission.id); db.notes = previousNotes; return; }
  openReservationQR(r.id);
  toast('QR sent to the admin inbox in this browser.');
};
A.viewQrSubmission = function(d) {
  if (!me() || me().role !== 'admin') return toast('This action is unavailable to your account.', true);
  const s = db.qrSubmissions.find(s => s.id === d.id), r = s && res(s.rid);
  if (!s || !r) return toast('The submitted QR could not be found.', true);
  REL = null; refreshRel();
  if (!s.viewedAt) {
    s.viewedAt = new Date().toISOString(); s.viewedBy = sess;
    if (!save()) { s.viewedAt = ''; s.viewedBy = ''; }
  }
  const note = db.notes.find(n => n.uid === sess && n.qrSubmissionId === s.id);
  if (note && !note.read) { note.read = true; if (!save()) note.read = false; }
  modal(`<h3>Received Reservation QR</h3><p class="mut">Sent by ${esc(usr(s.uid).name)} ${dt(s.sentAt)}</p><div class="qr qr-image"><img src="${/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.image) ? s.image : ''}" alt="Submitted QR for ${esc(r.id)}" width="484" height="484"></div><div class="ft"><button class="btn" data-a="downloadReservationQr" data-submission="${esc(s.id)}">Download QR</button></div>${dl({ 'Reservation ID': r.id, Borrower: esc(usr(s.uid).name), Status: badge(qrSubmissionState(s)) })}<p class="note">Download this image or take a screenshot. Then upload the QR on the verification page. Viewing or downloading a QR does not verify it or release equipment.</p><div class="ft"><a class="btn ghost" href="#/verify" data-a="close">Go to Verification</a></div>`);
  refreshQrInbox();
};

function qrNotificationAction(n) {
  if (n.qrSubmissionId && me().role === 'admin' && db.qrSubmissions.some(s => s.id === n.qrSubmissionId)) return `<button class="btn sm ghost qr-note-action" data-a="viewQrSubmission" data-id="${esc(n.qrSubmissionId)}">View Received QR</button>`;
  const r = n.reservationId && res(n.reservationId);
  return r && r.uid === sess && r.status === 'APPROVED' ? `<button class="btn sm ghost qr-note-action" data-a="qr" data-id="${esc(r.id)}">View QR and Reservation ID</button>` : '';
}
function receivedQrRows() {
  if (!db.qrSubmissions.length) return '<p class="empty">No QR codes received. Reservations appear here only after a member selects Send QR to Admin.</p>';
  return tbl(['Sender / Reservation', 'Received', 'Status', 'Actions'], [...db.qrSubmissions].sort((a, b) => b.sentAt.localeCompare(a.sentAt)).map(s => `<tr><td>${esc(usr(s.uid).name)}<small>${esc(s.rid)}</small></td><td>${dt(s.sentAt)}</td><td>${badge(qrSubmissionState(s))}</td><td><div class="act"><button class="btn sm ghost" data-a="viewQrSubmission" data-id="${esc(s.id)}">View QR</button><button class="btn sm ghost" data-a="downloadReservationQr" data-submission="${esc(s.id)}">Download</button></div></td></tr>`));
}
function refreshQrInbox() { const box = $('#qr-inbox'); if (box) box.innerHTML = receivedQrRows(); }
function qrVerificationView() {
  const lookup = panel('Verify Reservation', `<p class="mut" id="verify-help">Ask the borrower to present their reservation ID or QR. Enter the ID, scan their QR with a camera, or upload a QR image received from them.</p><label for="vid">QR value or reservation ID</label><div class="pwrow"><input id="vid" placeholder="Enter ID or QR value" autocomplete="off" spellcheck="false" aria-describedby="verify-help verr"><button class="btn" data-a="verify">Verify</button></div><div class="qr-entry-options"><div><h3>Scan at the office</h3><p class="hint">Point the camera at the QR on the borrower's phone or printed copy.</p><button class="btn ghost" data-a="startQrCamera">${uiIcon('camera')} Start Camera</button><button class="btn ghost" data-a="stopQrCamera" hidden>Stop Camera</button></div><div><h3>Upload a QR image</h3><p class="hint" id="qr-file-help">Choose a downloaded QR or screenshot. PNG, JPG or WebP; up to 10 MB.</p><label class="sr-only" for="qr-upload">QR image</label><input id="qr-upload" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="qr-file-help verr"></div></div><div id="qr-camera-area" hidden><video id="qr-camera" autoplay muted playsinline aria-label="Camera QR scanner preview"></video><p class="hint">Keep the entire QR inside the camera view.</p></div><div id="qr-read-status" class="hint" role="status"></div><div id="verr" class="err" role="alert"></div>`);
  const inbox = panel('QR Codes Sent by Members', `<p class="mut">Only QR codes explicitly sent by a member appear here. View or download a received code, then upload its image above to verify it.</p><p class="hint">This inbox uses records stored in this browser; it does not receive submissions from other devices.</p><div id="qr-inbox">${receivedQrRows()}</div>`);
  return `<div class="verification-workspace">${lookup}<div id="relbox" aria-live="polite">${REL ? relPanel() : ''}</div>${inbox}</div>`;
}
function recordQrVerification(r) {
  if (!me() || me().role !== 'admin') return;
  const submission = currentQrSubmission(r);
  if (!submission || submission.verifiedAt) return;
  const previousNotes = db.notes.slice();
  submission.verifiedAt = new Date().toISOString(); submission.verifiedBy = sess;
  notify(r.uid, `The equipment office verified the QR or reservation ID for ${r.id}. Equipment is released only after the administrator confirms your identity, schedule and equipment.`, 'qr-verified-' + submission.id, { reservationId: r.id });
  if (!save()) { submission.verifiedAt = ''; submission.verifiedBy = ''; db.notes = previousNotes; }
  refreshQrInbox();
}

function qrReadError(message) {
  REL = null; refreshRel();
  if ($('#verr')) $('#verr').textContent = message;
  if ($('#qr-read-status')) $('#qr-read-status').textContent = '';
}
function acceptScannedQr(value) {
  const input = $('#vid');
  if (!input || !me() || me().role !== 'admin') return;
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
  verifyValue(value);
}
function decodeQrSource(source, width, height, limit = 1800) {
  const scale = Math.min(1, limit / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
}
async function uploadReservationQr(file, input) {
  if (!file || !me() || me().role !== 'admin') return;
  stopQrCamera();
  const generation = qrReadGeneration, actor = sess, field = $('#vid');
  REL = null; refreshRel(); $('#verr').textContent = '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { input.value = ''; return qrReadError('Choose a PNG, JPG or WebP QR image.'); }
  if (file.size > 10 * 1024 * 1024) { input.value = ''; return qrReadError('The QR image is too large. Choose an image smaller than 10 MB.'); }
  $('#qr-read-status').innerHTML = '<span class="spinner" aria-hidden="true"></span> Reading QR image...';
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
    if (generation !== qrReadGeneration || actor !== sess || input !== $('#qr-upload') || field !== $('#vid')) return;
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 24000000) return qrReadError('This image is too large to process. Crop it to include the complete QR code.');
    const code = decodeQrSource(image, image.naturalWidth, image.naturalHeight);
    $('#qr-read-status').textContent = '';
    if (!code) return qrReadError('No readable QR code found. Upload a clear image with the complete QR and its white border.');
    acceptScannedQr(code.data);
  } catch {
    if (generation === qrReadGeneration && input === $('#qr-upload')) qrReadError('The QR image could not be read. Choose a valid image and try again.');
  } finally { URL.revokeObjectURL(url); if (input.isConnected) input.value = ''; }
}

function stopQrCamera() {
  qrReadGeneration++;
  if (qrReader) { clearTimeout(qrReader.timer); if (qrReader.stream) qrReader.stream.getTracks().forEach(track => track.stop()); qrReader = null; }
  const video = $('#qr-camera'); if (video) video.srcObject = null;
  const area = $('#qr-camera-area'); if (area) area.hidden = true;
  const start = $('[data-a="startQrCamera"]'); if (start) start.disabled = false;
  const stop = $('[data-a="stopQrCamera"]'); if (stop) stop.hidden = true;
  if ($('#qr-read-status')) $('#qr-read-status').textContent = '';
}
A.stopQrCamera = stopQrCamera;
A.startQrCamera = async function() {
  if (!me() || me().role !== 'admin' || !$('#qr-camera')) return;
  stopQrCamera(); REL = null; refreshRel(); $('#verr').textContent = '';
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return qrReadError('Camera scanning requires HTTPS or localhost and a browser with camera support. Upload a QR image or enter the reservation ID instead.');
  const reader = { generation: qrReadGeneration, actor: sess, stream: null, timer: null, video: $('#qr-camera') };
  qrReader = reader;
  $('[data-a="startQrCamera"]').disabled = true; $('[data-a="stopQrCamera"]').hidden = false;
  $('#qr-read-status').textContent = 'Waiting for camera access...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
    if (qrReader !== reader || reader.actor !== sess || !reader.video.isConnected) { stream.getTracks().forEach(track => track.stop()); return; }
    reader.stream = stream; reader.video.srcObject = stream; $('#qr-camera-area').hidden = false;
    await reader.video.play();
    if (qrReader !== reader) return;
    $('#qr-read-status').textContent = 'Camera ready. Present the borrower\'s QR code.';
    const scan = () => {
      if (qrReader !== reader || reader.actor !== sess || !reader.video.isConnected) return stopQrCamera();
      try {
        if (reader.video.readyState >= 2 && reader.video.videoWidth) {
          const code = decodeQrSource(reader.video, reader.video.videoWidth, reader.video.videoHeight, 1000);
          if (code) { stopQrCamera(); acceptScannedQr(code.data); return; }
        }
        reader.timer = setTimeout(scan, 250);
      } catch { stopQrCamera(); qrReadError('Camera scanning failed. Upload the QR image or use the reservation ID instead.'); }
    };
    scan();
  } catch (error) {
    if (qrReader !== reader) return;
    stopQrCamera();
    qrReadError(error.name === 'NotAllowedError' ? 'Camera access was denied. Allow camera access, upload a QR image, or enter the reservation ID.' : 'No usable camera is available. Connect a camera, upload a QR image, or enter the reservation ID.');
  }
};
document.addEventListener('change', event => { if (event.target.id === 'qr-upload') uploadReservationQr(event.target.files[0], event.target); });
document.addEventListener('input', event => { if (event.target.id === 'vid') stopQrCamera(); });
window.addEventListener('hashchange', stopQrCamera);
window.addEventListener('pagehide', stopQrCamera);
window.addEventListener('storage', stopQrCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopQrCamera(); });
// Rendering or opening another task cancels outstanding image/camera work.
const qrBaseRender = render, qrBaseModal = modal;
render = function() { stopQrCamera(); return qrBaseRender(); };
modal = function(html) { stopQrCamera(); return qrBaseModal(html); };
