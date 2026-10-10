/* Runs the browser-only app in headless Chrome through CDP. No npm packages.
   Usage: node tests/browser-workflow.cjs */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const screenshotDirectory = path.join(os.tmpdir(), 'cmu-equipment-screenshots');
const results = [], errors = [], downloadEvents = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, server, browserProfile;

async function main() {
  server = http.createServer((req, res) => {
    const relative = decodeURIComponent(req.url.split('?')[0]);
    const file = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); res.end(); return; }
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
      res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, debugPort = 9400 + Math.floor(Math.random() * 1000);
  browserProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'cmu-equipment-test-'));
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + browserProfile, 'about:blank'
  ], { windowsHide: true, stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; }
    catch {}
    await pause(100);
  }
  if (!target) throw new Error('Chrome debugging connection failed.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const p = pending.get(data.id); pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error.message)); else p.resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    if (data.method && data.method.startsWith('Browser.download')) downloadEvents.push(data.params);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async code => {
    const result = await cdp('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const check = async (name, code) => {
    const passed = await run(code);
    assert.equal(passed, true, name); results.push(name); console.log('PASS ' + name);
  };
  const capture = async name => {
    if (process.env.CMU_CAPTURE_SCREENSHOTS !== '1') return;
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    // Dismiss transient feedback so it does not cover the page under review.
    await run(`document.querySelectorAll('#toasts .toast').forEach(t=>t.remove())`);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(screenshotDirectory, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const inspectDialog = async (name, openCode) => {
    for (const width of [1440, 390]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
      await run(openCode); await pause(80);
      await check(`${name} dialog fits and isolates background at ${width}px`, `(()=>{const d=$('#modal .mb'),r=d.getBoundingClientRect();return !$('#modal').hidden&&d.getAttribute('role')==='dialog'&&!!d.getAttribute('aria-labelledby')&&d.scrollWidth<=d.clientWidth+1&&r.left>=0&&r.right<=innerWidth+1&&r.height<=innerHeight&&['login','uapp','aapp'].every(id=>$('#'+id).inert)})()`);
      await check(`${name} dialog traps keyboard focus at ${width}px`, `(()=>{const d=$('#modal .mb'),f=[...d.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')];f.at(-1).focus();f.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));return document.activeElement===f[0]})()`);
      await capture(`cmu-dialog-${name}-${width}`);
      await run('A.close()');
      await check(`${name} dialog restores background interaction at ${width}px`, `$('#modal').hidden&&['login','uapp','aapp'].every(id=>!$('#'+id).inert)`);
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  const waitReady = async () => {
    for (let i = 0; i < 100; i++) {
      try { if (await run(`document.readyState==='complete' && typeof db!=='undefined' && !!db && typeof A==='object'`)) return; }
      catch {}
      await pause(100);
    }
    throw new Error('App did not load: ' + errors.join('\n'));
  };
  const go = async route => { await run(`location.hash=${JSON.stringify('#/' + route)}`); await pause(80); };
  const waitDownload = async file => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fs.existsSync(file)) return;
      await pause(50);
    }
    throw new Error('QR download not found: ' + path.basename(file) + '; files: ' + fs.readdirSync(path.dirname(file)).join(', ') + '; events: ' + JSON.stringify(downloadEvents) + '; feedback: ' + await run(`$('#toasts').textContent`));
  };
  const uploadQr = async file => {
    const { root: document } = await cdp('DOM.getDocument');
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: document.nodeId, selector: '#qr-upload' });
    await cdp('DOM.setFileInputFiles', { nodeId, files: [file] });
    await pause(500);
  };
  const login = async (id, password) => {
    await run(`if (me()) A.logout(); $('#uid').value=${JSON.stringify(id)}; $('#pw').value=${JSON.stringify(password)}; $('#lf').requestSubmit();`);
    await pause(600);
  };
  const signup = async (id, name, email, password) => {
    await run(`A.showSignup(); $('#sun').value=${JSON.stringify(name)}; $('#suid').value=${JSON.stringify(id)}; $('#sut').value='Student'; $('#sud').value='Test Department'; $('#sue').value=${JSON.stringify(email)}; $('#sup').value=${JSON.stringify(password)}; $('#sup2').value=${JSON.stringify(password)}; $('#sf').requestSubmit();`);
    await pause(80);
  };

  await cdp('Page.enable'); await cdp('Runtime.enable');
  const downloadDirectory = path.join(browserProfile, 'downloads');
  fs.mkdirSync(downloadDirectory);
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-09T09:00:00+08:00']))}static now(){return new NativeDate('2026-10-09T09:00:00+08:00').getTime()}};` });
  await cdp('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await pause(600);
  await run('localStorage.clear(); location.reload()'); await pause(500); await waitReady();

  const year = await run('new Date().getFullYear()');
  const memberId = `${year}19001`, adminId = `${year}19002`;
  const memberPassword = `Member-${Date.now()}`, adminPassword = `Operator-${Date.now()}`;
  await check('CMU navy, gold, white and light-gray tokens match the supplied palette', `(()=>{const s=getComputedStyle(document.documentElement);return ['--pri','--gold','--card','--bg'].map(v=>s.getPropertyValue(v).trim().toUpperCase()).join(',')==='#0B2D6B,#F4B400,#FFFFFF,#F5F7FA'})()`);
  await check('Every branding image uses the supplied CMU logo and loads successfully', `[...document.querySelectorAll('img.seal,img.header-logo')].every(i=>i.getAttribute('src')==='assets/cmu-logo.png'&&i.complete&&i.naturalWidth===400&&i.naturalHeight===416)`);
  for (const width of [1440, 768, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    for (const [name, action] of [['login','showLogin'],['registration','showSignup'],['administrator-setup','showAdminSetup']]) {
      await run(`A.${action}()`);
      await check(`${name} form fits at ${width}px`, `document.documentElement.scrollWidth<=document.documentElement.clientWidth+1 && [...document.querySelectorAll('#login form:not([hidden])')].every(f=>f.getBoundingClientRect().top>=0)`);
      if ([1440, 390].includes(width)) await capture(`cmu-${name}-${width}`);
    }
  }
  await run('A.showLogin()');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await check('First launch starts with no accounts, inventory, or transactions', `db.schemaVersion===12 && !db.users.length && !db.cats.length && !db.equipment.length && !db.res.length && !db.brw.length && !db.notes.length && !db.qrSubmissions.length && !$('#login').hidden && !document.querySelector('.demo-accounts')`);
  await run('location.reload()'); await pause(500); await waitReady();
  await check('Empty inventory remains empty after refresh', `db.schemaVersion===12 && !db.cats.length && !db.equipment.length`);
  await check('First administrator setup is available only while no administrator exists', `!$('#admin-setup-link').hidden && $('#af').hidden`);
  await login(memberId, 'not-a-real-account');
  await check('Unknown account cannot log in', `!me() && $('#lerr').textContent.includes('Incorrect')`);
  await signup(memberId, 'Test Member', 'member@test.invalid', memberPassword);
  await check('Public signup creates a member account only', `usr(${JSON.stringify(memberId)}).role==='user' && !db.users.some(u=>u.role==='admin')`);
  await login(memberId, memberPassword);
  await check('Member can log in and sees empty-state counts', `me().id===${JSON.stringify(memberId)} && $('#uview').textContent.includes('0') && $('#uview').textContent.includes('No upcoming reservations')`);
  await check('Member dashboard has CMU branding and an honest recent-activity empty state', `$('#uview .campus-banner img').getAttribute('src')==='assets/cmu-logo.png' && $('#uview').textContent.includes('No activity yet.')`);
  await go('equipment');
  await check('Member equipment page clearly shows the empty inventory', `$('#uview').textContent.includes('No equipment matches your filters')`);
  await pause(100);
  await run('A.logout()');
  await run(`A.showAdminSetup(); $('#an').value='Authorized Operator'; $('#aid').value=${JSON.stringify(adminId)}; $('#ad').value='Test Office'; $('#ae').value='operator@test.invalid'; $('#apw').value=${JSON.stringify(adminPassword)}; $('#apw2').value=${JSON.stringify(adminPassword)}; $('#af').requestSubmit();`);
  await check('First administrator setup requires explicit confirmation', `$('#modal').textContent.includes('cannot verify that you are authorized') && !db.users.some(user=>user.role==='admin')`);
  await capture('cmu-setup-confirmation-1440');
  await run('A.yes()'); await pause(100);
  await check('First administrator is created with chosen credentials and setup closes', `usr(${JSON.stringify(adminId)}).role==='admin' && usr(${JSON.stringify(adminId)}).pw===${JSON.stringify(adminPassword)} && $('#af').hidden && $('#admin-setup-link').hidden`);
  await login(adminId, adminPassword);
  await check('Administrator can log in; public signup cannot assign that role', `me().id===${JSON.stringify(adminId)} && me().role==='admin' && db.users.find(u=>u.id===${JSON.stringify(memberId)}).role==='user'`);
  await check('Empty administrator dashboard counters are zero', `$('#aview').textContent.includes('Total Equipment') && $('#aview').textContent.includes('0') && $('#aview').textContent.includes('No reservations yet') && $('#aview').textContent.includes('No borrowing transactions yet')`);
  await check('Administrator dashboard and header use CMU branding', `$('#aview .campus-banner img').getAttribute('src')==='assets/cmu-logo.png' && getComputedStyle($('.ah')).backgroundColor==='rgb(11, 45, 107)' && getComputedStyle($('#side')).backgroundColor==='rgb(11, 45, 107)'`);
  await capture('cmu-admin-empty-dashboard-1440');
  await go('analytics');
  await check('Analytics uses an empty state before activity exists', `$('#aview').textContent.includes('No reservation, borrowing, return, or inspection activity')`);
  await go('reports');
  await run(`$('#rf').value=today();$('#rto').value=today();A.gen({},$('[data-a="gen"]'));`);
  await check('Report generation exposes an accessible loading indicator', `$('#rep .loading').getAttribute('role')==='status'&&$('[data-a="gen"]').getAttribute('aria-busy')==='true'`);
  await pause(500);
  await check('Reports have no records before real transactions exist', `REP && REP.rows.length===0 && $('#rep').textContent.includes('No records found')`);

  await go('categories');
  await run(`A.catForm({});$('#cn').value='Test Equipment';A.saveCat({n:''});`);
  const category = await run('db.cats.at(-1).name');
  await check('Administrator can add a category', `db.cats.length===1 && db.cats[0].name==='Test Equipment'`);
  await go('equipment');
  await inspectDialog('equipment-form', 'A.eqForm({})');
  await run(`A.eqForm({});$('#ek').value='TST-1001';$('#en').value='Test Projector';$('#ec').value=${JSON.stringify(category)};$('#eqq').value='4';$('#ed').value='Workflow test equipment';$('#eacq').value=today();A.saveEq({});`);
  await run(`A.eqForm({});$('#ek').value='TST-1002';$('#en').value='Test Microphone';$('#ec').value=${JSON.stringify(category)};$('#eqq').value='3';$('#ed').value='Second workflow test item';$('#eacq').value=today();A.saveEq({});`);
  await check('Administrator can create equipment with real inventory fields', `db.equipment.length===2 && eq('TST-1001').qty===4 && eq('TST-1001').acquired===today() && eq('TST-1002').qty===3`);
  await inspectDialog('equipment-details', `A.eqv({id:'TST-1001'})`);
  await inspectDialog('equipment-condition', `A.condForm({id:'TST-1001'})`);
  await run('A.logout()'); await login(memberId, memberPassword);
  await go('reserve');
  // Quantity cases use only this isolated test profile, then restore the workflow inventory.
  await run(`window.quantityCaseData=structuredClone(db);eq('TST-1001').name='Projector';eq('TST-1001').qty=3;eq('TST-1002').name='Projector';eq('TST-1002').qty=1;draft=freshDraft();render();$('#reservation-equipment-0').value='TST-1001';$('#reservation-equipment-0').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Same-name equipment is distinguished by ID without merging stock', `(()=>{const options=$$('#reservation-equipment-0 option').map(o=>o.textContent);return options.some(t=>t.includes('Projector')&&t.includes('TST-1001')&&t.includes('3 total'))&&options.some(t=>t.includes('Projector')&&t.includes('TST-1002')&&t.includes('1 total'))&&db.equipment.length===2})()`);
  await check('Before scheduling, the form labels requested quantity and does not claim scheduled availability', `$('#reservation-quantity-0').labels[0].textContent==='Quantity to reserve' && $('#reservation-quantity-0').value==='1' && $('#reservation-quantity-0').max==='3' && $('#av0').textContent.includes('Choose a date and time') && !$('#reservation-equipment-0').selectedOptions[0].textContent.includes('available /')`);
  await run(`$('[data-a="qty"][data-d="1"]').click();$('[data-a="qty"][data-d="1"]').click();$('[data-a="qty"][data-d="1"]').click();A.qty({i:'0',d:'1'});`);
  await check('Quantity increment stops at usable stock and disables the plus button', `draft.items[0].qty===3 && $('#reservation-quantity-0').value==='3' && $('[data-a="qty"][data-d="1"]').disabled`);
  await run(`$('[data-a="qty"][data-d="-1"]').click();$('[data-a="qty"][data-d="-1"]').click();A.qty({i:'0',d:'-1'});$('#rd').value=today();$('#rs').value='10:00';$('#rend').value='11:00';$('#rp').value='Quantity validation test';$('#rd').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Quantity decrement stops at one with a valid scheduled request', `draft.items[0].qty===1 && $('[data-a="qty"][data-d="-1"]').disabled && !validateDraft()`);
  for (const value of ['4', '1.5', '0', '']) {
    await run(`$('#reservation-quantity-0').value=${JSON.stringify(value)};$('#reservation-quantity-0').dispatchEvent(new Event('input',{bubbles:true}));$('[data-a="toReview"]').click();`);
    await check(`Typed invalid quantity ${JSON.stringify(value)} is flagged immediately and blocked from review`, `draft.step===1 && $('#reservation-quantity-0').value===${JSON.stringify(value)} && $('#reservation-quantity-0').getAttribute('aria-invalid')==='true' && !$('#reservation-quantity-0').checkValidity() && !!$('#rerr').textContent && $('#av0').classList.contains('bad')`);
  }
  await run(`$('#reservation-quantity-0').value='3';$('#reservation-quantity-0').dispatchEvent(new Event('input',{bubbles:true}));db.res.push({id:'QTY-APPROVED',uid:sess,date:today(),s:'10:00',e:'11:00',purpose:'Quantity test commitment',notes:'',status:'APPROVED',items:[{eq:'TST-1001',qty:2}],created:new Date().toISOString(),decided:new Date().toISOString(),reason:'',approvals:[]});$('#rd').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Overlapping commitments reduce scheduled availability while physical stock stays separate', `availQ(eq('TST-1001'))===3 && $('#reservation-quantity-0').max==='1' && $('#reservation-equipment-0').selectedOptions[0].textContent.includes('1 available / 3 total') && $('#av0').textContent.includes('Available for selected schedule: 1.')`);
  await check('An availability change preserves the requested quantity and flags the excess', `draft.items[0].qty===3 && $('#reservation-quantity-0').value==='3' && $('#reservation-quantity-0').getAttribute('aria-invalid')==='true' && $('[data-a="qty"][data-d="1"]').disabled && !!validateDraft()`);
  await run(`$('[data-a="qty"][data-d="-1"]').click()`);
  await check('Adjusting an excess quantity clears the error at the new available limit', `draft.items[0].qty===1 && $('#reservation-quantity-0').getAttribute('aria-invalid')==='false' && $('#reservation-quantity-0').checkValidity() && $('#rerr').textContent==='' && !validateDraft()`);
  for (const width of [1440, 768, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 641 });
    await check(`Scheduled quantity controls and labels fit at ${width}px`, `document.documentElement.scrollWidth<=document.documentElement.clientWidth+1 && $$('.ir select,.ir input,.ir button,.ir label').every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})`);
    await capture(`cmu-reservation-quantity-${width}`);
  }
  await run(`db.res.push({id:'QTY-BORROWED',uid:sess,date:today(),s:'08:00',e:'12:00',purpose:'Quantity borrowed test',status:'BORROWED',items:[{eq:'TST-1001',qty:1}],created:new Date().toISOString()});db.brw.push({id:'QTY-BRW',rid:'QTY-BORROWED',uid:sess,items:[{eq:'TST-1001',qty:1}],outAt:today()+'T08:00:00+08:00',status:'BORROWED'});$('#rd').dispatchEvent(new Event('input',{bubbles:true}));$('[data-a="toReview"]').click();`);
  await check('Borrowed units and overlapping approvals can exhaust a schedule without double counting', `availQ(eq('TST-1001'))===2 && $('#reservation-quantity-0').max==='0' && $('#reservation-quantity-0').disabled && $$('[data-a="qty"]').every(b=>b.disabled) && $('#reservation-equipment-0').value==='TST-1001' && $('#reservation-equipment-0').selectedOptions[0].disabled && $('#av0').textContent.includes('None available') && draft.step===1 && !!validateDraft()`);
  await capture('cmu-reservation-unavailable-320');
  await run(`$('#rs').value='12:00';$('#rend').value='13:00';$('#rs').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Moving past existing commitments restores schedule availability rather than using current on-hand stock', `availQ(eq('TST-1001'))===2 && $('#reservation-quantity-0').max==='3' && !$('#reservation-quantity-0').disabled && $('#reservation-equipment-0').selectedOptions[0].textContent.includes('3 available / 3 total') && !validateDraft()`);
  await run(`eq('TST-1001').maint=1;$('#rd').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Partial maintenance reduces the reservation quantity limit', `$('#reservation-quantity-0').max==='2' && $('#av0').textContent.includes('Available for selected schedule: 2.')`);
  for (const status of ['MAINTENANCE', 'UNAVAILABLE']) {
    await run(`eq('TST-1001').status=${JSON.stringify(status)};$('#rd').dispatchEvent(new Event('input',{bubbles:true}));`);
    await check(`${status} equipment cannot be requested through quantity controls or review`, `$('#reservation-quantity-0').max==='0' && $('#reservation-quantity-0').disabled && $('#reservation-equipment-0').selectedOptions[0].disabled && !!validateDraft()`);
  }
  await run(`eq('TST-1001').status='AVAILABLE';eq('TST-1001').maint=0;$('#rd').dispatchEvent(new Event('input',{bubbles:true}));$('[data-a="toReview"]').click()`);
  await check('Reservation review identifies the selected equipment and requested units', `draft.step===2 && $('#uview .its').textContent.includes('Projector (TST-1001)') && $('#uview .its').textContent.includes('Qty to reserve: 1')`);
  for (const width of [1440, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    await check(`Reservation quantity review fits at ${width}px`, `document.documentElement.scrollWidth<=document.documentElement.clientWidth+1 && $('#uview .its').scrollWidth<=$('#uview .its').clientWidth+1`);
    await capture(`cmu-reservation-quantity-review-${width}`);
  }
  await run(`eq('TST-1001').status='UNAVAILABLE';$('[data-a="submitRes"]').click();`);
  await check('Submission rechecks availability after review instead of accepting a stale quantity', `db.res.length===2 && !!$('#rerr').textContent && !db.res.some(r=>r.status==='PENDING')`);
  await run(`db=window.quantityCaseData;delete window.quantityCaseData;save();draft=freshDraft();render();`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await run(`draft={date:today(),s:'10:00',e:'12:00',purpose:'Workflow test reservation',notes:'Multiple-item test',items:[{eq:'TST-1001',qty:2},{eq:'TST-1002',qty:1}],step:1};render();`);
  await check('Multiple-item reservation schedule and stock validation work', `!validateDraft() && draft.items.length===2 && slotAvail('TST-1001',today(),'10:00','12:00')===4 && slotAvail('TST-1002',today(),'10:00','12:00')===3`);
  await run(`draft.step=2;A.submitRes({},$('[data-a="submitRes"]'));`); await pause(750);
  const rid = await run('db.res.at(-1).id');
  await check('Reservation submission stores linked equipment items and notification', `res(${JSON.stringify(rid)}).status==='PENDING' && res(${JSON.stringify(rid)}).items.length===2 && db.notes.some(n=>n.uid===${JSON.stringify(memberId)} && n.msg.includes(${JSON.stringify(rid)}))`);
  await run('A.logout()'); await login(adminId, adminPassword);
  await go('reservations');
  await inspectDialog('approval', `A.appr({id:${JSON.stringify(rid)}})`);
  await run(`A.appr({id:${JSON.stringify(rid)}});A.yes();`);
  await check('Approval links audit record and QR to the reservation', `res(${JSON.stringify(rid)}).status==='APPROVED' && !!res(${JSON.stringify(rid)}).qr && res(${JSON.stringify(rid)}).approvals.at(-1).by===${JSON.stringify(adminId)}`);
  await inspectDialog('reservation-qr', `A.qr({id:${JSON.stringify(rid)}})`);
  await go('verify');
  for (const width of [1440, 768, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    await check(`QR verification awaits a borrower-supplied code without exposing approved reservations at ${width}px`, `!REL && $('#vid').value==='' && $('#relbox').textContent==='' && !$('#aview').textContent.includes(${JSON.stringify(rid)}) && !$('#aview').textContent.includes('Test Member') && !$('#aview').textContent.includes('Approved Reservations Awaiting Release') && !$('[data-a="verifyReservationId"]') && document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
    await capture(`cmu-verify-awaiting-code-${width}`);
  }
  await run(`$('[data-a="verify"]').click()`);
  await check('An empty verification input shows an error without revealing a reservation', `!REL && $('#relbox').textContent==='' && $('#verr').textContent.includes('Enter the QR value')`);
  await run(`$('#vid').value=${JSON.stringify(rid)};$('#vid').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Entering an ID alone does not display or verify reservation details', `!REL && $('#relbox').textContent==='' && $('#verr').textContent===''`);
  await run(`$('[data-a="verify"]').click()`); await pause(600);
  await check('Verifying the borrower-supplied ID displays the matching approved reservation', `REL.rid===${JSON.stringify(rid)} && $('#relbox').textContent.includes(${JSON.stringify(rid)}) && $('#relbox').textContent.includes('Test Member') && $$('.rck').length===3 && res(${JSON.stringify(rid)}).status==='APPROVED' && !brwOf(${JSON.stringify(rid)})`);
  for (const width of [1440, 768, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    await check(`Verified reservation and release controls fit at ${width}px`, `document.documentElement.scrollWidth<=document.documentElement.clientWidth+1 && $('#relbox [data-a="release"]').getBoundingClientRect().width<innerWidth`);
    await capture(`cmu-verify-matched-reservation-${width}`);
  }
  await run(`$('#vid').value='NONEXISTENT-ID';$('#vid').dispatchEvent(new Event('input',{bubbles:true}));`);
  await check('Editing the presented code immediately clears the previous borrower and release controls', `!REL && $('#relbox').textContent==='' && !$('[data-a="release"]')`);
  await run(`$('[data-a="verify"]').click()`); await pause(600);
  await check('Unknown reservation IDs are rejected by QR verification', `!REL && $('#verr').textContent.includes('Reservation not found')`);
  await run(`$('#vid').value=JSON.stringify({q:'INVALID-QR',r:${JSON.stringify(rid)}});$('#vid').dispatchEvent(new Event('input',{bubbles:true}));$('[data-a="verify"]').click()`); await pause(600);
  await check('A mismatched QR payload does not reveal reservation details', `!REL && $('#relbox').textContent==='' && $('#verr').textContent.includes('does not match')`);
  await run(`$('#vid').value=${JSON.stringify(rid)};$('#vid').dispatchEvent(new Event('input',{bubbles:true}));$('[data-a="verify"]').click();$('#vid').value='DIFFERENT-ID';$('#vid').dispatchEvent(new Event('input',{bubbles:true}));`); await pause(600);
  await check('A pending lookup cannot restore details after its input changes', `!REL && $('#relbox').textContent==='' && $('#verr').textContent===''`);
  await run(`$('#vid').value=${JSON.stringify(rid)};$('[data-a="verify"]').click()`); await pause(600);
  await go('reservations'); await go('verify');
  await check('Reopening QR verification requires the borrower to present the code again', `!REL && $('#vid').value==='' && $('#relbox').textContent==='' && !$('#aview').textContent.includes(${JSON.stringify(rid)})`);

  await run('A.logout()'); await login(memberId, memberPassword);
  await go('notifications');
  await check('The member receives an approval notification linked to their QR and reservation ID', `!!$('#uview [data-a="qr"][data-id="${rid}"]') && !db.qrSubmissions.length`);
  await inspectDialog('member-approved-qr', `A.qr({id:${JSON.stringify(rid)}})`);
  await run(`A.qr({id:${JSON.stringify(rid)}})`);
  await check('The approved member QR offers its real ID, PNG download and explicit send action', `$('#qr-reservation-id').value===${JSON.stringify(rid)} && $('#qrc').src.startsWith('data:image/png;base64,') && !!$('#modal [data-a="sendReservationQr"]') && !db.qrSubmissions.length`);
  await run(`$('#modal [data-a="downloadReservationQr"]').click()`);
  const downloadedQr = path.join(downloadDirectory, `CMU-${rid}-QR.png`);
  await waitDownload(downloadedQr);
  await check('Member QR download creates a PNG file that can be uploaded at the office', `${fs.readFileSync(downloadedQr).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))}`);
  await run(`window.qrNotesBeforeFailure=db.notes.length;window.qrStorageWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('Test storage failure','QuotaExceededError')};try{A.sendReservationQr({id:${JSON.stringify(rid)}})}finally{Storage.prototype.setItem=window.qrStorageWrite}`);
  await check('A storage failure does not claim delivery or retain a QR submission or notifications', `!db.qrSubmissions.length && db.notes.length===window.qrNotesBeforeFailure && !$('#modal [data-a="sendReservationQr"]').disabled`);
  await run(`$('#modal [data-a="sendReservationQr"]').click()`);
  const submissionId = await run('db.qrSubmissions[0].id');
  await check('Member sending stores the actual QR and notifies the administrator', `db.qrSubmissions.length===1 && db.qrSubmissions[0].uid===${JSON.stringify(memberId)} && db.qrSubmissions[0].rid===${JSON.stringify(rid)} && db.qrSubmissions[0].payload===qrText(res(${JSON.stringify(rid)})) && !!db.qrSubmissions[0].image && db.notes.some(n=>n.uid===${JSON.stringify(adminId)}&&n.qrSubmissionId===${JSON.stringify(submissionId)}) && $('#modal [data-a="sendReservationQr"]').disabled && !db.qrSubmissions[0].verifiedAt`);
  await capture('cmu-member-qr-sent-1440');
  await run(`A.sendReservationQr({id:${JSON.stringify(rid)}});A.viewQrSubmission({id:${JSON.stringify(submissionId)}})`);
  await check('Repeated sending creates no duplicate and members cannot open the admin received-QR dialog', `db.qrSubmissions.length===1 && !db.qrSubmissions[0].viewedAt && $('#modal h3').textContent==='Reservation QR Code'`);
  await run('A.close();A.logout()'); await login(adminId, adminPassword); await go('verify');
  await check('Admin receives only the explicitly sent QR and receiving it does not verify or release equipment', `$('#qr-inbox').textContent.includes(${JSON.stringify(rid)}) && !!$('#qr-inbox [data-a="viewQrSubmission"]') && !REL && $('#vid').value==='' && !db.qrSubmissions[0].verifiedAt && !brwOf(${JSON.stringify(rid)})`);
  await capture('cmu-admin-qr-inbox-1440');
  await run(`A.sendReservationQr({id:${JSON.stringify(rid)}})`);
  await check('Administrators cannot send a QR on behalf of the member', `db.qrSubmissions.length===1`);
  await go('notifications');
  await check('Admin notification opens the submitted QR through a guarded action', `!!$('#aview [data-a="viewQrSubmission"][data-id="${submissionId}"]')`);
  await inspectDialog('received-member-qr', `A.viewQrSubmission({id:${JSON.stringify(submissionId)}})`);
  await check('Viewing a received QR records the admin viewer without verifying or borrowing', `!!db.qrSubmissions[0].viewedAt && db.qrSubmissions[0].viewedBy===${JSON.stringify(adminId)} && !db.qrSubmissions[0].verifiedAt && !brwOf(${JSON.stringify(rid)})`);
  const adminDownloadDirectory = path.join(downloadDirectory, 'administrator');
  fs.mkdirSync(adminDownloadDirectory);
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: adminDownloadDirectory, eventsEnabled: true });
  await run(`A.viewQrSubmission({id:${JSON.stringify(submissionId)}});$('#modal [data-a="downloadReservationQr"]').click()`);
  const adminDownloadedQr = path.join(adminDownloadDirectory, `CMU-${rid}-QR.png`);
  await waitDownload(adminDownloadedQr);
  const submittedImage = await run('db.qrSubmissions[0].image');
  await check('Administrator can download the exact received QR image', `${fs.existsSync(adminDownloadedQr) && fs.readFileSync(adminDownloadedQr).equals(Buffer.from(submittedImage.split(',')[1], 'base64'))}`);
  await run(`$('#modal .mb').scrollTop=0`);
  const screenshotQrFile = path.join(downloadDirectory, 'received-qr-screenshot.png');
  const qrScreenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(screenshotQrFile, Buffer.from(qrScreenshot.data, 'base64'));
  await run('A.close()');
  await go('verify');
  for (const width of [1440, 768, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    await check(`Camera, image upload and received-QR inbox fit at ${width}px`, `!!$('#qr-upload') && !!$('[data-a="startQrCamera"]') && document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
    await capture(`cmu-qr-interaction-${width}`);
  }
  await uploadQr(downloadedQr);
  await check('Uploading the downloaded member QR decodes the image and verifies the canonical reservation', `REL.rid===${JSON.stringify(rid)} && $('#vid').value===qrText(res(${JSON.stringify(rid)})) && $('#verr').textContent==='' && !!db.qrSubmissions[0].verifiedAt && db.qrSubmissions[0].verifiedBy===${JSON.stringify(adminId)} && db.notes.some(n=>n.uid===${JSON.stringify(memberId)}&&n.key==='qr-verified-'+${JSON.stringify(submissionId)}) && !brwOf(${JSON.stringify(rid)})`);
  await uploadQr(screenshotQrFile);
  await check('Uploading a screenshot of the received QR verifies the same reservation', `REL.rid===${JSON.stringify(rid)} && $('#verr').textContent===''`);
  for (const type of ['jpeg', 'webp']) {
    const encodedImage = await run(`(async()=>{const image=new Image();await new Promise(resolve=>{image.onload=resolve;image.src=reservationQrImage(qrText(res(${JSON.stringify(rid)})))});const canvas=document.createElement('canvas');canvas.width=canvas.height=484;canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL('image/${type}',.9)})()`);
    const imageFile = path.join(downloadDirectory, 'qr.' + type);
    fs.writeFileSync(imageFile, Buffer.from(encodedImage.split(',')[1], 'base64'));
    await uploadQr(imageFile);
    await check(`A ${type.toUpperCase()} QR image is decoded and validated`, `REL.rid===${JSON.stringify(rid)} && $('#verr').textContent===''`);
  }
  await uploadQr(path.join(root, 'assets', 'cmu-logo.png'));
  await check('A picture without a QR clears the prior result and cannot release equipment', `!REL && $('#relbox').textContent==='' && $('#verr').textContent.includes('No readable QR')`);
  await uploadQr(path.join(root, 'README.md'));
  await check('Unsupported QR upload types are rejected clearly', `!REL && $('#verr').textContent.includes('Choose a PNG') && $('#qr-upload').value===''`);
  await run(`$('#vid').value=${JSON.stringify(rid)};$('[data-a="verify"]').click();uploadReservationQr(new File(['text'],'invalid.txt',{type:'text/plain'}),$('#qr-upload'));true`); await pause(600);
  await check('Switching to image upload cancels a pending manual verification', `!REL && $('#relbox').textContent==='' && $('#verr').textContent.includes('Choose a PNG')`);
  await run(`uploadReservationQr(new File([new Uint8Array(10*1024*1024+1)],'large.png',{type:'image/png'}),$('#qr-upload'))`);
  await check('Oversized images are rejected before decoding', `!REL && $('#verr').textContent.includes('too large')`);
  const forgedQrFile = path.join(downloadDirectory, 'forged-qr.png');
  const forgedQrImage = await run(`reservationQrImage(JSON.stringify({q:'FORGED',r:${JSON.stringify(rid)}}))`);
  fs.writeFileSync(forgedQrFile, Buffer.from(forgedQrImage.split(',')[1], 'base64'));
  await uploadQr(forgedQrFile);
  await check('An uploaded QR with a forged payload cannot reveal or release the reservation', `!REL && $('#relbox').textContent==='' && $('#verr').textContent.includes('does not match')`);
  await run(`window.qrOriginalGetMedia=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied for test','NotAllowedError')};`);
  await run('A.startQrCamera()');
  await check('Camera permission denial leaves manual ID and image upload available', `!qrReader && $('#verr').textContent.includes('denied') && !$('[data-a="startQrCamera"]').disabled && !!$('#vid') && !!$('#qr-upload')`);
  // A real canvas video stream exercises the scanner's video/frame/decode path.
  await run(`navigator.mediaDevices.getUserMedia=async constraints=>{window.qrCameraConstraints=constraints;const canvas=document.createElement('canvas');canvas.width=canvas.height=484;const image=new Image();await new Promise(resolve=>{image.onload=resolve;image.src=reservationQrImage(qrText(res(${JSON.stringify(rid)})))});window.qrCameraCanvas=canvas;window.qrCameraTestStream=canvas.captureStream(5);canvas.getContext('2d').drawImage(image,0,0);return window.qrCameraTestStream}`);
  await run('A.startQrCamera()'); await pause(700);
  await check('Camera frames decode the member QR and stop the video tracks after verification', `REL.rid===${JSON.stringify(rid)} && !qrReader && window.qrCameraTestStream.getTracks().every(t=>t.readyState==='ended') && window.qrCameraConstraints.audio===false && $('#qr-camera-area').hidden && db.notes.filter(n=>n.key==='qr-verified-'+${JSON.stringify(submissionId)}).length===1`);
  await run(`navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{window.qrResolveCamera=resolve});A.startQrCamera();true`);
  await run(`A.stopQrCamera();window.qrLateCameraStream=document.createElement('canvas').captureStream(1);window.qrResolveCamera(window.qrLateCameraStream);`); await pause(80);
  await check('Cancelling pending camera permission stops a stream that arrives afterward', `!qrReader && window.qrLateCameraStream.getTracks().every(t=>t.readyState==='ended') && $('#qr-camera-area').hidden`);
  await run(`navigator.mediaDevices.getUserMedia=async()=>{const canvas=document.createElement('canvas');window.qrNavigationStream=canvas.captureStream(5);canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height);return window.qrNavigationStream}`);
  await run('A.startQrCamera()');
  await go('reservations');
  await check('Leaving QR verification stops the active camera stream', `!qrReader && window.qrNavigationStream.getTracks().every(t=>t.readyState==='ended')`);
  await run('navigator.mediaDevices.getUserMedia=window.qrOriginalGetMedia'); await go('verify');

  await run(`$('#vid').value=qrText(res(${JSON.stringify(rid)}));$('#vid').dispatchEvent(new Event('input',{bubbles:true}));$('[data-a="verify"]').click()`); await pause(600);
  await check('A borrower-supplied valid QR verifies its approved reservation', `REL.rid===${JSON.stringify(rid)} && $('#relbox').textContent.includes(${JSON.stringify(rid)}) && $('#verr').textContent===''`);
  await run(`$('[data-a="release"]').click()`);
  await check('Verification still requires all release confirmations before borrowing', `res(${JSON.stringify(rid)}).status==='APPROVED' && !brwOf(${JSON.stringify(rid)}) && $('#rerr').textContent.includes('all three confirmations')`);
  await run(`res(${JSON.stringify(rid)}).date=addDays(1);refreshRel()`);
  await check('A verified future reservation still cannot be released before its date', `$('[data-a="release"]').disabled && $('#rerr').textContent.includes('reservation date') && !brwOf(${JSON.stringify(rid)})`);
  await run(`res(${JSON.stringify(rid)}).date=today();refreshRel();$$('.rck').forEach(c=>c.checked=true);$('[data-a="release"]').click();$('#vid').value='CHANGED-ID';$('#vid').dispatchEvent(new Event('input',{bubbles:true}));`); await pause(750);
  await check('Changing the presented code cancels an equipment release that is still pending', `!REL && !brwOf(${JSON.stringify(rid)}) && res(${JSON.stringify(rid)}).status==='APPROVED'`);
  await uploadQr(downloadedQr);
  await run(`$$('.rck').forEach(c=>c.checked=true);$('[data-a="release"]').click()`); await pause(750);
  const bid = await run(`brwOf(${JSON.stringify(rid)}).id`);
  await check('Verified approved reservation creates the linked borrowing record', `res(${JSON.stringify(rid)}).status==='BORROWED' && brwOf(${JSON.stringify(rid)}).id===${JSON.stringify(bid)} && brwOf(${JSON.stringify(rid)}).releasedBy===${JSON.stringify(adminId)}`);
  await uploadQr(downloadedQr);
  await check('A previously released QR cannot create another borrowing transaction', `!REL && $('#verr').textContent.includes('BORROWED') && db.brw.filter(b=>b.rid===${JSON.stringify(rid)}).length===1 && qrSubmissionState(db.qrSubmissions[0])==='BORROWED'`);
  for (const width of [1440, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    await go('returns/' + bid);
    await check(`Return inspection renders each borrowed item at ${width}px`, `$('#aview').textContent.includes(${JSON.stringify(bid)})&&$$('.insp').length===2&&document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
    await capture(`cmu-return-inspection-${width}`);
  }
  await run(`INSP={bid:${JSON.stringify(bid)},at:new Date().toISOString(),c:{0:'Good',1:'Needs Maintenance'},r:{0:'',1:'Maintenance test condition'},v:true};A.confirmReturn({id:${JSON.stringify(bid)}},$('#confirmRet'));A.yes();`); await pause(750);
  await check('Return inspection completes linked items and records condition history', `res(${JSON.stringify(rid)}).status==='COMPLETED' && brwOf(${JSON.stringify(rid)}).status==='RETURNED' && res(${JSON.stringify(rid)}).items.length===2 && eq('TST-1001').hist[0].rid===${JSON.stringify(rid)} && availQ(eq('TST-1001'))===4 && eq('TST-1002').maint===1 && availQ(eq('TST-1002'))===2`);
  await run('A.logout()'); await login(memberId, memberPassword);
  await go('reserve');
  await run(`draft={date:today(),s:'13:00',e:'14:00',purpose:'Rejection workflow test',notes:'',items:[{eq:'TST-1001',qty:1}],step:1};render();draft.step=2;A.submitRes({},$('[data-a="submitRes"]'));`); await pause(750);
  const rejectedRid = await run('db.res.at(-1).id');
  await run('A.logout()'); await login(adminId, adminPassword); await go('reservations');
  await inspectDialog('rejection', `A.rej({id:${JSON.stringify(rejectedRid)}})`);
  await run(`A.rej({id:${JSON.stringify(rejectedRid)}});A.doReject({id:${JSON.stringify(rejectedRid)}});`);
  await check('Rejection requires a reason', `res(${JSON.stringify(rejectedRid)}).status==='PENDING' && $('#rjerr').textContent.includes('reason')`);
  await run(`$('#rj').value='Not available for this schedule.';A.doReject({id:${JSON.stringify(rejectedRid)}});`);
  await check('Rejection records its reason, decision and member notification', `res(${JSON.stringify(rejectedRid)}).status==='REJECTED' && res(${JSON.stringify(rejectedRid)}).reason==='Not available for this schedule.' && db.notes.some(n=>n.uid===${JSON.stringify(memberId)}&&n.msg.includes('rejected'))`);
  await go('reports'); await run(`$('#rt').value='Return Report';$('#rf').value=today();$('#rto').value=today();A.gen({},$('[data-a="gen"]'));`); await pause(450);
  await check('Return report includes the actual completed transaction only', `REP.rows.length===1 && REP.rows[0].includes(${JSON.stringify(rid)}) && !REP.rows[0].includes(${JSON.stringify(rejectedRid)})`);
  await go('analytics');
  await check('Analytics reflects actual reservation and borrowing records', `!$('#aview').textContent.includes('No reservation, borrowing, return, or inspection activity') && $('#aview').textContent.includes('Reservation Frequency')`);
  await check('CSV export is available for a generated actual-record report', `REP.rows.length===1 && typeof A.csv==='function'`);
  await run('A.logout()'); await login(memberId, memberPassword);
  await check('Records persist across logout and login', `db.res.some(r=>r.id===${JSON.stringify(rid)}) && db.brw.some(b=>b.id===${JSON.stringify(bid)}) && localStorage.getItem(SKEY)===${JSON.stringify(memberId)} && db.qrSubmissions.some(s=>s.id===${JSON.stringify(submissionId)}&&!!s.viewedAt&&!!s.verifiedAt)`);
  await go('notifications');
  await check('The member receives the administrator verification notification', `$('#uview').textContent.includes('The equipment office verified') && db.qrSubmissions[0].verifiedBy===${JSON.stringify(adminId)}`);

  const widths = [1440, 1024, 768, 430, 390, 360];
  await run('A.logout()'); await login(adminId, adminPassword);
  for (const width of widths) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    await check(`Administrator navigation labels fit their items at ${width}px`, `$$('#anav a').every(a=>[...a.querySelectorAll('.ni,.nl')].every(c=>{const x=c.getBoundingClientRect(),r=a.getBoundingClientRect();return x.top>=r.top-1&&x.bottom<=r.bottom+1}))`);
    for (const route of ['dashboard', 'reservations', 'verify', 'borrowings', 'returns', 'equipment', 'categories', 'conditions', 'maintenance', 'users', 'analytics', 'reports', 'notifications', 'profile', 'settings']) {
      await go(route);
      await check(`Administrator ${route} renders at ${width}px without horizontal overflow`, `!!$('#aview').innerHTML && document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
      if ([1440,768,390].includes(width)) await capture(`cmu-admin-${route}-${width}`);
    }
  }
  await run('A.menu()');
  await check('Administrator mobile navigation opens with an accurate expanded state', `$('#side').classList.contains('open')&&$('#abnav [data-a="menu"]').getAttribute('aria-expanded')==='true'`);
  await capture('cmu-admin-mobile-menu');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await check('Escape closes administrator mobile navigation and updates its state', `!$('#side').classList.contains('open')&&$('#abnav [data-a="menu"]').getAttribute('aria-expanded')==='false'`);
  await run('A.logout()'); await login(memberId, memberPassword);
  for (const width of widths) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 641 });
    for (const route of ['dashboard', 'equipment', 'reserve', 'my', 'borrowed', 'history', 'notifications', 'profile']) {
      await go(route);
      await check(`Member ${route} renders at ${width}px without horizontal overflow`, `!!$('#uview').innerHTML && document.documentElement.scrollWidth<=document.documentElement.clientWidth+1`);
      if ([1440,768,390].includes(width)) await capture(`cmu-member-${route}-${width}`);
    }
  }
  await run('A.userMenu()');
  await check('Member mobile menu is keyboard accessible and isolates page content', `!$('#umenu').hidden&&$('#uview').inert&&document.activeElement===$('.member-menu')&&$('#unav .more-button').getAttribute('aria-expanded')==='true'`);
  await capture('cmu-member-mobile-menu');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await check('Escape closes the member menu and restores focus to its toggle', `$('#umenu').hidden&&!$('#uview').inert&&document.activeElement===$('#unav .more-button')`);

  await run(`const version11={...db,schemaVersion:11};delete version11.qrSubmissions;localStorage.setItem(KEY,JSON.stringify(version11));location.reload()`); await pause(600); await waitReady();
  await check('Version 11 upgrades preserve existing accounts, inventory, reservations, QR and transactions', `db.schemaVersion===12 && db.users.length===2 && db.equipment.length===2 && !!res(${JSON.stringify(rid)}).qr && res(${JSON.stringify(rid)}).items.length===2 && !!brwOf(${JSON.stringify(rid)}) && db.qrSubmissions.length===0`);

  await run(`const cats=['Computing','Audio/Visual','Camera','Furniture','Other'].map(name=>({name,arch:false}));const items=[['PRJ-0001','Projector','Audio/Visual',5,'HD projector with HDMI and VGA cables.'],['LAP-0003','Laptop','Computing',10,'Core i5 laptop with charger for classroom and research use.'],['CAM-0002','Camera','Camera',2,'DSLR camera with tripod and memory card.'],['MIC-0001','Microphone','Audio/Visual',4,'Wireless handheld microphone set.'],['SPK-0001','Speaker','Audio/Visual',3,'Portable PA speaker with stand.'],['TBL-0001','Table','Furniture',12,'Folding event table, 6 ft.'],['EXT-0001','Extension Cord Set','Other',6,'5-meter extension cord with surge protection.'],['PRJ-0002','Projector #002','Audio/Visual',1,'Spare projector with lamp issue.'],['TRI-0001','Tripod','Camera',3,'Adjustable camera tripod with carrying bag.'],['SCR-0001','Projector Screen','Audio/Visual',2,'Portable pull-up projection screen.']].map(([id,name,cat,qty,desc])=>({id,name,cat,qty,desc,acquired:'',cond:'Good',status:'AVAILABLE',maint:0,flag:false,arch:false,hist:[]}));localStorage.setItem(KEY,JSON.stringify({...emptyData(),schemaVersion:10,cats,equipment:items}));location.reload();`); await pause(600); await waitReady();
  await check('Upgrade clears the exact unmodified project catalog', `db.schemaVersion===12 && !db.cats.length && !db.equipment.length`);
  await run(`const cats=['Audio-Visual','Computing & Accessories','Audio Equipment','Classroom & Event Equipment'].map(name=>({name,arch:false}));const items=[['AV-001','LCD Projector','Audio-Visual',2],['AV-002','Projection Screen','Audio-Visual',2],['CMP-001','Laptop','Computing & Accessories',3],['CMP-002','HDMI Cable','Computing & Accessories',6],['AUD-001','PA Speaker','Audio Equipment',2],['AUD-002','Wireless Microphone','Audio Equipment',4],['CLS-001','Extension Cord','Classroom & Event Equipment',4],['CLS-002','Webcam','Classroom & Event Equipment',2]].map(([id,name,cat,qty])=>({id,name,cat,qty,desc:'Suggested quantity; verify actual stock.',acquired:'',cond:'Good',status:'AVAILABLE',maint:0,flag:false,arch:false,hist:[]}));localStorage.setItem(KEY,JSON.stringify({...emptyData(),schemaVersion:9,cats,equipment:items}));location.reload();`); await pause(600); await waitReady();
  await check('Upgrade clears the exact untouched placeholder catalog', `db.schemaVersion===12 && !db.cats.length && !db.equipment.length`);
  await run(`const custom={...emptyData(),schemaVersion:10,cats:[{name:'Existing Category',arch:false}],equipment:[{id:'REAL-001',name:'Existing Equipment',cat:'Existing Category',qty:7,desc:'Existing user inventory',acquired:'',cond:'Good',status:'AVAILABLE',maint:0,flag:false,arch:false,hist:[]}]};localStorage.setItem(KEY,JSON.stringify(custom));location.reload();`); await pause(600); await waitReady();
  await check('Upgrade preserves customized existing inventory', `db.schemaVersion===12 && db.cats.length===1 && db.cats[0].name==='Existing Category' && db.equipment.length===1 && db.equipment[0].id==='REAL-001'`);
  await run(`localStorage.setItem(KEY,JSON.stringify({...db,schemaVersion:6}));localStorage.setItem(SKEY,${JSON.stringify(memberId)});location.reload();`); await pause(600); await waitReady();
  await check('Legacy browser data is hidden pending explicit reset without overwriting it', `legacyResetRequired && $('#modal').textContent.includes('permanently clears') && db.users.length===0 && JSON.parse(localStorage.getItem(KEY)).schemaVersion===6 && !localStorage.getItem(SKEY)`);
  await run(`A.migrationReset()`); await pause(100);
  await check('Confirmed clean-start reset clears old records and session', `!legacyResetRequired && !localStorage.getItem(SKEY) && db.users.length===0 && db.equipment.length===0 && db.res.length===0 && db.brw.length===0`);
  await run('location.reload()'); await pause(500); await waitReady();
  await check('Explicit reset stays empty after refresh', `db.schemaVersion===12 && !db.users.length && !db.equipment.length && !db.cats.length && !db.res.length && !db.brw.length && !db.notes.length && !db.qrSubmissions.length && !me()`);
  await check('No browser JavaScript exceptions were recorded', `true`);
  if (errors.length) throw new Error(errors.join('\n'));

  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify({ passed: results.length, failed: 0, checks: results, errors }, null, 2));
  console.log(`\n${results.length} checks passed.`);
  if (process.env.CMU_CAPTURE_SCREENSHOTS === '1') console.log('Screenshots saved outside the project: ' + screenshotDirectory);
}

main().catch(error => {
  console.error(error);
  try { fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify({ passed: results.length, failed: 1, checks: results, errors, failure: error.message }, null, 2)); } catch {}
  process.exitCode = 1;
}).finally(async () => {
  if (socket) socket.close();
  if (browser) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill(); await exited;
  }
  if (server) server.close();
  if (browserProfile) {
    const target = path.resolve(browserProfile), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(temporaryRoot) || !path.basename(target).startsWith('cmu-equipment-test-')) throw new Error('Unexpected browser test profile path.');
    fs.rmSync(target, { recursive: true, force: true });
  }
});
