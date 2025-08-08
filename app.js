let device, server, service;
let pollTimer = null;
let lastOnTick = 0;

const $ = (s) => document.querySelector(s);
const td = new TextDecoder();
const te = new TextEncoder();

const state = {
  connected: false,
  uuids: {}
};

// ====== UI helpers
function log(msg, level='info') {
  const t = new Date().toLocaleTimeString();
  $('#log').textContent += `[${t}] ${msg}\n`;
  $('#log').scrollTop = $('#log').scrollHeight;
  const c = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  c(msg);
}
function setStatus(txt, cls='') { $('#status').textContent = `Status: ${txt}`; $('#status').className = cls; }
function setKv(id, text) { $(id).textContent = text; }
function uiEnable(connected) {
  $('#btnConnect').disabled = connected;
  $('#btnReconnect').disabled = !device;
  $('#btnDisconnect').disabled = !connected;
  $('#btnStandard').disabled = !connected;
  $('#btnTurbo').disabled = !connected;
  $('#btnPower').disabled = !connected;
  setKv('#valConn', connected ? 'Connected' : 'Disconnected');
}
function sanitizeUuid(u){ return (u||'').trim().toLowerCase(); }

// ====== History (optional local storage)
function todayKey(){ const d=new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function loadHist(){ try{ return JSON.parse(localStorage.getItem('hist')||'{}'); }catch{return{}} }
function saveHist(h){ localStorage.setItem('hist', JSON.stringify(h)); }
function bumpUsage(minutes){
  const h = loadHist(); const k=todayKey();
  h[k]=(h[k]||0)+minutes; saveHist(h); renderHist();
}
function renderHist(){
  const h = loadHist();
  const today=todayKey();
  const {yKey,yVal}=(()=>{
    const d=new Date(); d.setDate(d.getDate()-1);
    const k=`${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
    return {yKey:k,yVal:h[k]||0};
  })();
  $('#valToday').textContent = h[today]||0;
  $('#valYesterday').textContent = yVal;
}

// ====== BLE helpers
function parseValue(dv){
  if (!dv) return '—';
  const bytes = new Uint8Array(dv.buffer);
  if ($('#asText').checked) {
    try { const str = td.decode(bytes); if (/[ -~]/.test(str) && str.trim()) return str; } catch {}
  }
  return '0x ' + Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join(' ');
}
function toUint16LE(dv){ return dv.getUint16(0, true); }
function toUint8(dv){ return dv.getUint8(0); }

async function getCharacteristic(uuid){
  return await service.getCharacteristic(sanitizeUuid(uuid));
}
async function subscribe(uuid, onValue){
  const id = sanitizeUuid(uuid); if (!id) return;
  const ch = await getCharacteristic(id);
  if (!(ch.properties.notify || ch.properties.indicate)) {
    // fallback single read
    try{ const v=await ch.readValue(); onValue(v, parseValue(v)); } catch(e){ log(`readValue(${id}): ${e.message}`,'error'); }
    return {subscribed:false};
  }
  ch.addEventListener('characteristicvaluechanged', ev => {
    const dv = ev.target.value; onValue(dv, parseValue(dv));
  });
  await ch.startNotifications();
  // initial read
  try{ const v=await ch.readValue(); onValue(v, parseValue(v)); } catch {}
  log(`Notifications started on ${id}`);
  return {subscribed:true,ch};
}
async function poll(uuid, onValue, ms=2000){
  const id=sanitizeUuid(uuid); if (!id) return;
  const ch = await getCharacteristic(id);
  const tick = async ()=>{
    try{ const v=await ch.readValue(); onValue(v, parseValue(v)); }
    catch(e){ clearInterval(pollTimer); pollTimer=null; log(`poll ${id}: ${e.message}`,'error'); }
  };
  await tick();
  pollTimer = setInterval(tick, ms);
  log(`Polling ${id} every ${ms}ms`);
}

// ====== Control bytes (adjust to your firmware)
// Example protocol (choose what your firmware expects):
// POWER toggle: 0x10, MODE standard: 0x20, MODE turbo: 0x21
async function writeControl(byteArray){
  const id = sanitizeUuid($('#uuidState').value);
  if (!id){ log('Control/State UUID not set','warn'); return; }
  const ch = await getCharacteristic(id);
  if (!(ch.properties.write || ch.properties.writeWithoutResponse)){ log('Control characteristic not writable','warn'); return; }
  await ch.writeValue(new Uint8Array(byteArray));
  log(`Wrote ${byteArray.map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
}

// ====== Connect flow
async function connectFlow(reuse=false){
  try{
    state.uuids = {
      svc: sanitizeUuid($('#uuidService').value),
      state: $('#uuidState').value,
      volt:  $('#uuidVolt').value,
      pct:   $('#uuidPct').value,
      chg:   $('#uuidCharge').value,
      spd:   $('#uuidSpeeds').value
    };
    if (!navigator.bluetooth) { setStatus('Web Bluetooth not supported','err'); return; }
    if (!state.uuids.svc) { setStatus('Enter Service UUID','warn'); return; }

    setStatus(reuse ? 'Reconnecting…' : 'Requesting device…');
    if (!reuse){
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'Atovio' },
          { services: [ state.uuids.svc ] }
        ],
        optionalServices: [ state.uuids.svc ] // and any others you read
      });
      device.addEventListener('gattserverdisconnected', onDisconnected);
      $('#devName').textContent = `Device: ${device.name || 'Unknown'}`;
      $('#devId').textContent = `ID: ${device.id || '—'}`;
    }

    setStatus('Connecting…');
    server = await device.gatt.connect();
    service = await server.getPrimaryService(state.uuids.svc);

    uiEnable(true); state.connected = true; setStatus('Connected','ok');
    log(`Connected to ${device.name || 'device'}`);
    if ($('#autoStart').checked) await startData();
  }catch(e){ handleError('connectFlow', e); }
}

async function startData(){
  // battery voltage
  if (state.uuids.volt) await subscribe(state.uuids.volt, (dv, text)=>{
    try {
      // prefer numeric if firmware sends uint16 mV; else fall back to text/hex
      const mv = toUint16LE(dv); // adjust if your firmware differs
      if (!isNaN(mv) && mv>0) {
        const v = (mv/1000).toFixed(2) + ' V';
        setKv('#valVolt', v); $('#valLastV').textContent = v;
      } else { setKv('#valVolt', text); }
    } catch { setKv('#valVolt', text); }
  });

  // fan percent (0-100)
  if (state.uuids.pct) await subscribe(state.uuids.pct, (dv, text)=>{
    try { const p = toUint8(dv); setKv('#valPct', `${p}%`); } catch { setKv('#valPct', text); }
  });

  // charging (0/1)
  if (state.uuids.chg) await subscribe(state.uuids.chg, (dv, text)=>{
    try { const c = toUint8(dv); setKv('#valCharge', c ? 'Charging' : 'Not charging'); } catch { setKv('#valCharge', text); }
  });

  // state (bitmask / text)
  if (state.uuids.state) await subscribe(state.uuids.state, (dv, text)=>{
    try {
      const s = toUint8(dv);
      const flags = [];
      if (s & 0x01) flags.push('ON'); else flags.push('OFF');
      if (s & 0x02) flags.push('Turbo');
      setKv('#valState', flags.join(' / '));
      // usage log: count minutes while ON
      const now = Date.now();
      if (s & 0x01) {
        if (!lastOnTick) lastOnTick = now;
      } else if (lastOnTick) {
        const mins = Math.round((now - lastOnTick)/60000);
        if (mins>0) bumpUsage(mins);
        lastOnTick = 0;
      }
    } catch { setKv('#valState', text); }
  });

  // speeds (polling)
  if (state.uuids.spd) await poll(state.uuids.spd, (dv, text)=>{
    setKv('#valSpeeds', text);
  }, 2000);
}

function onDisconnected(){
  uiEnable(false); state.connected=false; setStatus('Disconnected','warn'); log('Device disconnected','warn');
  if (pollTimer) clearInterval(pollTimer); pollTimer=null;
  if (lastOnTick){ const mins=Math.round((Date.now()-lastOnTick)/60000); if (mins>0) bumpUsage(mins); lastOnTick=0; }
}

async function disconnect(){
  try{ if (device?.gatt?.connected) device.gatt.disconnect(); } catch(e){ handleError('disconnect', e); }
  finally{ onDisconnected(); }
}

function handleError(where, e){
  const name=e?.name||'Error'; const msg=e?.message||String(e);
  log(`${where}: ${name}: ${msg}`,'error'); setStatus(`${name}: ${msg}`,'err');
}

// ====== UI events
$('#btnConnect').onclick   = () => connectFlow(false);
$('#btnReconnect').onclick = () => connectFlow(true);
$('#btnDisconnect').onclick= () => disconnect();
$('#btnClearLog').onclick  = () => { $('#log').textContent=''; };
$('#btnResetHistory').onclick = () => { localStorage.removeItem('hist'); renderHist(); };

$('#btnPower').onclick   = async ()=> writeControl([0x10]); // toggle power
$('#btnStandard').onclick= async ()=> writeControl([0x20]); // standard mode
$('#btnTurbo').onclick   = async ()=> writeControl([0x21]); // turbo mode

// init
uiEnable(false); renderHist();
