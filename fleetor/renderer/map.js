// fleetor — map.js — verbatim port of dashboard operations map (~775–1084)
// A4: export function initMap({ baseUrl }) returns { start, stop, destroy }
export function initMap({ baseUrl }) {
  // ---- constants (dashboard lines 775–796) ----
  const TYPES = ['TASK','ANS','DONE','REVISE','ASK','BLOCKED','FYI','MSG','RAW'];
  const DARK_TEXT_TYPES = new Set(['DONE','REVISE','ANS']);
  const TYPE_COLOR = t => getComputedStyle(document.documentElement)
    .getPropertyValue('--t-' + (TYPES.includes(t)?t:'MSG')).trim() || '#8b93a1';

  const LAYOUT = {
    orchestrator:{x:.5, y:.18, head:true, role:'Coordinator', model:'Opus'},
    worker1:{x:.20, y:.60, role:'Implementer', model:'DeepSeek'},
    worker2:{x:.38, y:.74, role:'Implementer', model:'DeepSeek'},
    worker3:{x:.62, y:.74, role:'Implementer', model:'DeepSeek'},
    worker4:{x:.80, y:.60, role:'UI / Gallery', model:'Sonnet'},
  };
  const COUNTER_POS = {x:.5, y:.40};
  const DOOR_POS = {x:.5, y:.025};
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---- captured element refs (populated in start()) ----
  let stage, nodesEl, flyer, wires, staticWires;
  let deskEls = {};

  // ---- interval / listener handles ----
  let pollHandle = null;
  let clockHandle = null;
  let resizeHandler = null;

  // ---- helpers ----
  function stageRect(){ return stage.getBoundingClientRect(); }
  function centerOf(name){
    const el = deskEls[name];
    const s = stageRect();
    if (el){
      const r = el.getBoundingClientRect();
      return {x:r.left - s.left + r.width/2, y:r.top - s.top + r.height/2};
    }
    if (name === 'human' || name === 'user') return {x:DOOR_POS.x*s.width, y:DOOR_POS.y*s.height};
    return {x:.5*s.width, y:.5*s.height};
  }

  function placeFixed(){
    const c = document.getElementById('counter');
    c.style.left = (COUNTER_POS.x*100)+'%'; c.style.top = (COUNTER_POS.y*100)+'%';
    const door = document.getElementById('door');
    door.style.left = (DOOR_POS.x*100)+'%'; door.style.top = (DOOR_POS.y*100)+'%';
  }

  // ---- static hub-and-spoke wires ----
  function drawStaticWires(){
    staticWires.innerHTML = '';
    const hub = centerOf('orchestrator');
    const spokes = ['worker1','worker2','worker3','worker4'];
    for (const name of spokes){
      line(hub, centerOf(name));
    }
    const counterEl = document.getElementById('counter');
    const r = counterEl.getBoundingClientRect(), s = stageRect();
    line(hub, {x:r.left-s.left+r.width/2, y:r.top-s.top+r.height/2});
  }
  function line(a,b){
    const el = document.createElementNS(SVG_NS,'line');
    el.setAttribute('x1',a.x); el.setAttribute('y1',a.y);
    el.setAttribute('x2',b.x); el.setAttribute('y2',b.y);
    el.setAttribute('stroke','var(--border-strong)');
    el.setAttribute('stroke-width','1');
    el.setAttribute('opacity','0.55');
    staticWires.appendChild(el);
  }

  // ---- flying token animation (new message: sender -> target) ----
  function fly(msg){
    const a = centerOf(msg.sender), b = centerOf(msg.target);
    const color = TYPE_COLOR(msg.type);
    const el = document.createElement('div');
    el.className = 'token';
    el.style.background = color;
    el.style.color = DARK_TEXT_TYPES.has(msg.type) ? '#0a0c10' : '#fff';
    el.textContent = msg.type;
    flyer.appendChild(el);

    const path = document.createElementNS(SVG_NS,'path');
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2 - Math.min(120, Math.hypot(b.x-a.x,b.y-a.y)*0.28);
    path.setAttribute('d', `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
    path.setAttribute('fill','none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width','1.5');
    path.setAttribute('stroke-linecap','round');
    path.setAttribute('opacity','0.5');
    wires.appendChild(path);
    path.animate([{opacity:.5},{opacity:0}], {duration:1400, easing:'ease-out'})
        .onfinish = () => path.remove();

    pulseNode(msg.sender);
    const dur = 1200;
    const start = performance.now();
    function frame(now){
      let t = (now-start)/dur; if (t>1) t=1;
      const et = t<.5 ? 2*t*t : -1+(4-2*t)*t; // easeInOutQuad
      const x = (1-et)*(1-et)*a.x + 2*(1-et)*et*mx + et*et*b.x;
      const y = (1-et)*(1-et)*a.y + 2*(1-et)*et*my + et*et*b.y;
      el.style.transform = `translate(${x-16}px,${y-9}px)`;
      el.style.opacity = t<.12 ? (t/.12) : (t>.85 ? (1-(t-.85)/.15) : 1);
      if (t<1) requestAnimationFrame(frame); else { el.remove(); flashInbox(msg.target); }
    }
    requestAnimationFrame(frame);
  }
  function pulseNode(name){
    const d = deskEls[name]; if(!d) return;
    d.classList.add('on'); clearTimeout(d._lt);
    d._lt = setTimeout(()=>{ if(!d.dataset.active) d.classList.remove('on'); }, 900);
  }
  function flashInbox(name){
    const d = deskEls[name]; if(!d) return;
    const inbox = d.querySelector('.inbox');
    inbox.classList.remove('bump'); void inbox.offsetWidth; inbox.classList.add('bump');
  }

  // ---- render state ----
  function renderTotals(c){
    const el = document.getElementById('totals');
    el.innerHTML =
      stat('q','QUEUED',c.queued)+stat('a','ACTIVE',c.active)+
      stat('b','BLOCKED',c.blocked)+stat('m','MERGED',c.merged)+
      stat('','MSGS',c.messages)+stat('','REVISE',c.revises);
  }
  function stat(cls,label,v){
    return `<div class="stat ${cls}"><b>${v}</b><span>${label}</span></div>`;
  }

  function esc(s){ return (s||'').replace(/[&<>]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }

  function renderDesks(state){
    const act = state.activity || {};
    for (const name of Object.keys(LAYOUT)){
      const d = deskEls[name];
      const sess = (state.sessions||[]).find(s=>s.name===name) || {};
      const a = act[name];
      const status = d.querySelector('[data-status]');
      const files = d.querySelector('[data-files]');
      d.classList.remove('on','idle','blocked'); delete d.dataset.active;

      if (a && a.kind === 'working'){
        d.classList.add('on'); d.dataset.active = '1';
        status.innerHTML = `<div class="doing">working <span class="tid">${esc(a.task)}</span></div>`+
          (a.notes?`<div class="notes">${esc(a.notes)}</div>`:'');
      } else if (a && a.kind === 'blocked'){
        d.classList.add('blocked');
        status.innerHTML = `<div class="doing">blocked on <span class="tid">${esc(a.task)}</span></div>`+
          (a.notes?`<div class="notes">${esc(a.notes)}</div>`:'');
      } else {
        d.classList.add('idle');
        let label = 'idle';
        if (sess.status === 'down') label = 'offline';
        else if (sess.status === 'native') label = 'native session';
        else if (name === 'orchestrator') label = 'monitoring fleet';
        status.innerHTML = `<div class="idle-label">${label}</div>`;
      }
      // claimed files
      const mine = (state.claims||[]).filter(c=>c.worker===name);
      files.innerHTML = mine.slice(0,3).map(c=>`<span class="file-chip" title="${esc(c.file)}">${esc(shortFile(c.file))}</span>`).join('')
        + (mine.length>3?`<span class="file-chip">+${mine.length-3}</span>`:'');
      // inbox
      const n = (state.inbox||{})[name] || 0;
      setInbox(d, n);
    }
  }
  function shortFile(f){ const p=(f||'').split('/'); return p[p.length-1]||f; }
  function setInbox(d, n){
    const inbox = d.querySelector('.inbox');
    const dots = d.querySelector('[data-dots]');
    const nEl = d.querySelector('[data-n]');
    const prev = +nEl.textContent || 0;
    nEl.textContent = n;
    inbox.classList.toggle('empty', n===0);
    const show = Math.min(n, 5);
    if (dots.childElementCount !== show){
      dots.innerHTML = '';
      for (let i=0;i<show;i++){ const b=document.createElement('div'); b.className='dot-mini'; dots.appendChild(b); }
    }
    if (n>prev){ inbox.classList.remove('bump'); void inbox.offsetWidth; inbox.classList.add('bump'); }
  }

  function renderBoards(tasks){
    const active = tasks.filter(t=>t.state==='ACTIVE'||t.state==='BLOCKED');
    const rest = tasks.filter(t=>t.state==='QUEUED'||t.state==='MERGED')
      .sort((a,b)=> (a.state==='QUEUED'?0:1)-(b.state==='QUEUED'?0:1));
    fillBoard('rows-active', active, 'Nothing in progress');
    fillBoard('rows-queue', rest, 'Queue empty');
  }
  function fillBoard(id, list, emptyMsg){
    const el = document.getElementById(id);
    if (!list.length){ el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
    el.innerHTML = list.slice(0,14).map(t=>
      `<div class="task-row ${t.state}"><span class="sid">${esc(t.id)}</span>`+
      (t.revises>0?`<span class="rev">↻${t.revises}</span>`:'')+
      `<span class="who">${esc(t.assignee||'')}</span></div>`).join('');
  }

  function renderCounter(queue){
    const el = document.getElementById('counter');
    const n = (queue||[]).length;
    document.getElementById('qd').textContent = n;
    el.classList.toggle('zero', n===0);
  }

  function shortTime(ts){
    if (!ts) return '';
    const t = ts.replace('T',' ').split(' ')[1] || ts;
    return t.slice(0,8);
  }

  function renderTicker(messages){
    const el = document.getElementById('log-rows');
    const last = messages.slice(-6).reverse();
    if (!last.length){ el.innerHTML = '<div class="log-empty">No activity yet</div>'; return; }
    el.innerHTML = last.map(m=>{
      const color = TYPE_COLOR(m.type);
      const textColor = DARK_TEXT_TYPES.has(m.type) ? '#0a0c10' : '#fff';
      return '<div class="log-row">'+
        `<span class="t">${esc(shortTime(m.ts))}</span>`+
        `<span class="badge" style="background:${color};color:${textColor}">${esc(m.type)}</span>`+
        `<span class="flow"><b>${esc(m.sender)}</b> → ${esc(m.target)}</span>`+
        `<span class="msg">${esc(stripType(m.text))}</span>`+
      '</div>';
    }).join('');
  }
  function stripType(text){
    const parts = (text||'').split(/\s+/);
    if (TYPES.includes(parts[0]) || parts[0]==='(raw)') return parts.slice(1).join(' ');
    return text;
  }

  function renderLegend(){
    const el = document.getElementById('legend');
    el.innerHTML = ['TASK','DONE','REVISE','ASK','ANS','BLOCKED','FYI'].map(t=>
      `<span class="li"><span class="dot" style="background:${TYPE_COLOR(t)}"></span>${t}</span>`).join('');
  }

  // ---- clock / uptime ----
  let firstTs = null;
  function tickClock(){
    const now = new Date();
    document.getElementById('clock').textContent = now.toTimeString().slice(0,8);
    const up = document.getElementById('uptime');
    if (firstTs){
      const start = new Date(firstTs.replace(' ','T'));
      if (!isNaN(start)){
        let s = Math.max(0,(now-start)/1000);
        const h=Math.floor(s/3600), m=Math.floor(s%3600/60), ss=Math.floor(s%60);
        up.textContent = 'up ' + (h?h+'h ':'') + m+'m '+ss+'s';
      } else up.textContent = 'since '+firstTs;
    } else up.textContent = 'idle — no traffic yet';
  }

  // ---- poll loop ----
  let lastSeq = -1, primed = false;
  async function poll(){
    try{
      const r = await fetch(baseUrl + '/api/state', {cache:'no-store'});
      const st = await r.json();
      const pane = document.getElementById('pane-map');
      const offlineOverlay = document.querySelector('#pane-map .offline.overlay');
      if (pane) pane.classList.remove('disconnected');
      if (offlineOverlay) offlineOverlay.classList.add('hidden');
      if (st.error) return;
      firstTs = st.firstTs;
      renderTotals(st.counts);
      renderDesks(st);
      renderBoards(st.tasks||[]);
      renderCounter(st.queue||[]);
      renderTicker(st.messages||[]);

      const msgs = st.messages||[];
      const maxSeq = msgs.length ? msgs[msgs.length-1].seq : -1;
      if (!primed){ lastSeq = maxSeq; primed = true; }
      else {
        const fresh = msgs.filter(m=>m.seq>lastSeq);
        fresh.forEach((m,i)=> setTimeout(()=>fly(m), i*180));
        if (maxSeq>lastSeq) lastSeq = maxSeq;
      }
    } catch(e){
      const pane = document.getElementById('pane-map');
      const offlineOverlay = document.querySelector('#pane-map .offline.overlay');
      if (pane) pane.classList.add('disconnected');
      if (offlineOverlay) offlineOverlay.classList.remove('hidden');
    }
  }

  // ---- start: build DOM, wire intervals, kick off ----
  function start() {
    stage = document.getElementById('stage');
    nodesEl = document.getElementById('nodes');
    flyer = document.getElementById('flyer');
    wires = document.getElementById('wires');
    staticWires = document.getElementById('static-wires');

    // build nodes once
    nodesEl.innerHTML = '';
    flyer.innerHTML = '';
    for (const [name,cfg] of Object.entries(LAYOUT)){
      const d = document.createElement('div');
      d.className = 'node idle' + (cfg.head?' head':'');
      d.id = 'node-' + name;
      d.style.left = (cfg.x*100)+'%';
      d.style.top  = (cfg.y*100)+'%';
      d.innerHTML =
        '<div class="row-top"><span class="dot"></span>'+
        '<span class="name">'+name+'</span>'+
        '<span class="model">'+cfg.model+'</span></div>'+
        '<div class="role">'+cfg.role+'</div>'+
        '<div class="statusline" data-status></div>'+
        '<div class="files" data-files></div>'+
        '<div class="inbox empty"><span class="label">inbox</span>'+
          '<div class="inbox-dots" data-dots></div><span class="n" data-n>0</span></div>';
      nodesEl.appendChild(d);
      deskEls[name] = d;
    }

    placeFixed();
    drawStaticWires();
    renderLegend();

    // intervals (capture handles for stop/destroy)
    clockHandle = setInterval(tickClock, 1000);
    tickClock();
    pollHandle = setInterval(poll, 1200);
    poll();

    // resize listener (stored for destroy cleanup)
    resizeHandler = () => drawStaticWires();
    window.addEventListener('resize', resizeHandler);
  }

  // ---- stop: clear intervals, keep DOM + resize listener intact ----
  function stop() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    if (clockHandle) { clearInterval(clockHandle); clockHandle = null; }
  }

  // ---- destroy: full teardown — intervals + resize listener ----
  function destroy() {
    stop();
    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
  }

  return { start, stop, destroy };
}
