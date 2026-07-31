// fleetor — chat.js — streaming orchestrator chat port
// Ported verbatim from bin/dashboard lines ~1086–1453, with C2 deltas applied.

// ---- private helpers (duplicated per C2 item 6 to avoid cross-module deps) ----

function esc(s) {
  return (s || '').replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

// Agent list (mirrors LAYOUT keys from the dashboard — chat only needs the names)
const AGENTS = ['orchestrator', 'worker1', 'worker2', 'worker3', 'worker4'];

// ---- public mount ----

export function initChat({ baseUrl }) {
  // ---- element refs (moved inside per C2 item 1) ----
  const chatPanel = document.getElementById('chat-panel');
  const chatAgentSel = document.getElementById('chat-agent');
  const chatTranscript = document.getElementById('chat-transcript');
  const chatErrorEl = document.getElementById('chat-error');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send');

  // optional (dashboard slide-over controls — may not exist in app pane)
  const chatToggle = document.getElementById('chat-toggle');
  const chatClose = document.getElementById('chat-close');

  // ---- agent select population ----
  for (const name of AGENTS) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    chatAgentSel.appendChild(opt);
  }
  let chatAgent = chatAgentSel.value = 'orchestrator';
  let chatOpen = false;
  let chatScrolledUp = false;
  // cursor into events/<agent>.jsonl, in LINES — shared between the one-shot
  // backfill (/api/chat) and the SSE tail (/api/chat/stream?since=), since both
  // endpoints count file lines identically.
  let streamCursor = 0;
  let chatES = null;          // the live EventSource, if any
  let chatStreamGen = 0;      // bumped on every (re)connect/teardown to invalidate stale timers/callbacks
  let activeTurn = null;      // in-flight streamed turn: {blocks: {index: {...}}} | null

  // ---- chat-open toggle (kept per C2 item 3 — optional controls) ----

  function setChatOpen(open) {
    chatOpen = open;
    if (chatPanel) {
      chatPanel.classList.toggle('open', open);
      chatPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (chatToggle) chatToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { backfillChat(); chatInput.focus(); } else { closeChatStream(); }
  }

  if (chatToggle) chatToggle.addEventListener('click', () => setChatOpen(!chatOpen));
  if (chatClose) chatClose.addEventListener('click', () => setChatOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chatOpen) setChatOpen(false);
  });

  // ---- agent select change handler ----
  chatAgentSel.addEventListener('change', () => {
    chatAgent = chatAgentSel.value;
    chatInput.placeholder = `Message ${chatAgent}…`;
    streamCursor = 0;
    chatScrolledUp = false;
    chatTranscript.innerHTML = '<div class="chat-empty">No messages yet.</div>';
    showChatError('');
    closeChatStream();
    if (chatOpen) backfillChat();
  });
  chatInput.placeholder = `Message ${chatAgent}…`;

  // ---- error display ----

  function showChatError(msg) {
    if (!msg) { chatErrorEl.hidden = true; chatErrorEl.textContent = ''; return; }
    chatErrorEl.hidden = false;
    chatErrorEl.textContent = msg;
  }

  // ---- backfill (finalized history) then live tail (token-by-token) ----

  async function backfillChat() {
    const agent = chatAgent; // guard against a race with an agent switch mid-flight
    try {
      const r = await fetch(baseUrl + '/api/chat?agent=' + encodeURIComponent(agent) + '&since=0', { cache: 'no-store' });
      const data = await r.json().catch(() => ({}));
      if (agent !== chatAgent) return; // user switched away while this was in flight
      if (!r.ok) { showChatError(data.error || `chat request failed (${r.status})`); return; }
      showChatError(data.error || '');
      if (data.messages && data.messages.length) appendChatMessages(data.messages);
      streamCursor = typeof data.total === 'number' ? data.total : 0;
    } catch (e) {
      if (agent !== chatAgent) return;
      showChatError('lost connection to dashboard server');
      streamCursor = 0;
    }
    if (agent === chatAgent && chatOpen) connectChatStream();
  }

  function connectChatStream() {
    closeChatStream();
    const agent = chatAgent;
    const gen = ++chatStreamGen;
    // C2 item 2 crux: ABSOLUTE URL for EventSource — a relative URL resolves
    // against file:// in the Electron renderer and silently fails.
    const es = new EventSource(baseUrl + '/api/chat/stream?agent=' + encodeURIComponent(agent) + '&since=' + streamCursor);
    chatES = es;
    es.onmessage = (e) => {
      if (gen !== chatStreamGen) return;
      streamCursor++;
      let ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      handleStreamEvent(ev);
    };
    es.onerror = () => {
      if (gen !== chatStreamGen) return;
      es.close();
      // auto-reconnect while the panel is still open on this agent
      setTimeout(() => { if (gen === chatStreamGen && chatOpen) connectChatStream(); }, 1500);
    };
  }

  function closeChatStream() {
    chatStreamGen++; // invalidate any in-flight onmessage/reconnect callbacks
    if (chatES) { chatES.close(); chatES = null; }
    activeTurn = null;
  }

  // ---- raw claude stream-json event -> DOM (dedup'd against the consolidated events) ----

  function handleStreamEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'stream_event') {
      const se = ev.event || {};
      if (se.type === 'message_start') activeTurn = { blocks: {} };
      else if (se.type === 'content_block_start') onBlockStart(se.index, se.content_block);
      else if (se.type === 'content_block_delta') onBlockDelta(se.index, se.delta);
      else if (se.type === 'content_block_stop') onBlockStop(se.index);
      // message_delta / message_stop: no rendering action needed
    } else if (ev.type === 'assistant') {
      // Already streamed live via deltas above -> skip to avoid double-rendering.
      // Only fall back to the consolidated event when no live turn was seen
      // (e.g. this agent doesn't support --include-partial-messages, or we
      // reconnected mid-turn and missed message_start).
      if (!activeTurn) renderConsolidatedAssistant(ev);
    } else if (ev.type === 'result') {
      finalizeTurn(ev);
    }
    // system/init, rate_limit_event, stderr, raw: ignore
  }

  function onBlockStart(index, block) {
    if (!activeTurn) activeTurn = { blocks: {} };
    const kind = block && block.type;
    if (kind === 'text') {
      const el = document.createElement('div');
      el.className = 'chat-bubble assistant chat-streaming';
      appendChatNode(el);
      activeTurn.blocks[index] = { kind: 'text', el, raw: '' };
    } else if (kind === 'tool_use') {
      const el = document.createElement('div');
      el.className = 'chat-tool-row';
      el.innerHTML = '<span class="chat-tool-dot"></span><span class="chat-tool-name mono">' + esc(block.name || 'tool') + '</span>' +
        '<span class="chat-tool-detail mono"></span>';
      appendChatNode(el);
      activeTurn.blocks[index] = { kind: 'tool', el, raw: '' };
    } else {
      activeTurn.blocks[index] = { kind: 'other' }; // e.g. thinking — not rendered
    }
  }

  function onBlockDelta(index, delta) {
    const b = activeTurn && activeTurn.blocks[index];
    if (!b || !delta) return;
    if (delta.type === 'text_delta' && b.kind === 'text') {
      b.raw += delta.text || '';
      b.el.innerHTML = renderRichText(b.raw);
      autoscrollChat();
    } else if (delta.type === 'input_json_delta' && b.kind === 'tool') {
      b.raw += delta.partial_json || '';
      const detail = b.el.querySelector('.chat-tool-detail');
      if (detail) detail.textContent = truncatePreview(b.raw);
    }
    // thinking_delta / signature_delta: not rendered
  }

  function onBlockStop(index) {
    const b = activeTurn && activeTurn.blocks[index];
    if (!b) return;
    if (b.kind === 'text') {
      b.el.classList.remove('chat-streaming');
    } else if (b.kind === 'tool') {
      let preview;
      try { preview = truncatePreview(JSON.stringify(JSON.parse(b.raw))); }
      catch (e) { preview = truncatePreview(b.raw); }
      const detail = b.el.querySelector('.chat-tool-detail');
      if (detail) { detail.textContent = preview; detail.title = preview; }
    }
  }

  function finalizeTurn(ev) {
    appendChatNode(chatResultDivider({
      isError: !!ev.is_error,
      cost: ev.total_cost_usd,
      turns: ev.num_turns,
    }));
    activeTurn = null;
  }

  function renderConsolidatedAssistant(ev) {
    const content = (ev.message && ev.message.content) || [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        appendChatNode(chatBubble('assistant', block.text));
      } else if (block.type === 'tool_use') {
        appendChatNode(chatToolRow({ text: block.name || 'tool', detail: truncatePreview(JSON.stringify(block.input || {})) }));
      }
    }
  }

  function truncatePreview(s, limit) {
    if (limit === undefined) limit = 90;
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length <= limit ? s : s.slice(0, limit - 1) + '…';
  }

  // ---- markdown (assistant text only — user bubbles stay plain) ----

  function mdEscape(s) {
    return (s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function mdInline(s) {
    s = s.replace(/`([^`\n]+)`/g, (_, code) => '<code class="chat-md-code mono">' + code + '</code>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      (_, t, u) => '<a href="' + u + '" target="_blank" rel="noopener noreferrer" class="chat-md-link">' + t + '</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="chat-md-strong">$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong class="chat-md-strong">$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em class="chat-md-em">$2</em>');
    s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em class="chat-md-em">$2</em>');
    return s;
  }

  function mdCodeBlock(lang, code) {
    const body = code.replace(/\n$/, '');
    const label = lang ? '<div class="chat-code-lang">' + lang + '</div>' : '';
    return '<div class="chat-code-wrap">' + label + '<pre class="chat-code mono">' + body + '</pre></div>';
  }

  function renderRichText(text) {
    // 1. escape HTML first — everything below operates on already-safe text.
    let src = mdEscape(text || '');
    // 2. pull out fenced code blocks so their contents are never touched by
    //    inline/list/heading parsing, and guarantee each sits on its own line.
    const codeBlocks = [];
    src = src.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang, code });
      return '@@CB' + idx + '@@';
    });
    src = src.replace(/([^\n])(@@CB\d+@@)/g, '$1\n$2').replace(/(@@CB\d+@@)([^\n])/g, '$1\n$2');

    const lines = src.split('\n');
    let html = '';
    let list = null; // {type:'ul'|'ol', items:''}
    const closeList = () => { if (list) { html += '<' + list.type + ' class="chat-md-list">' + list.items + '</' + list.type + '>'; list = null; } };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === '') { closeList(); i++; continue; }

      const cb = trimmed.match(/^@@CB(\d+)@@$/);
      if (cb) { closeList(); const b = codeBlocks[+cb[1]]; html += mdCodeBlock(b.lang, b.code); i++; continue; }

      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        html += '<h' + level + ' class="chat-md-h">' + mdInline(heading[2]) + '</h' + level + '>';
        i++; continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { closeList(); html += '<hr class="chat-md-hr">'; i++; continue; }

      if (trimmed.startsWith('&gt;')) {
        closeList();
        const quoted = [];
        while (i < lines.length && lines[i].trim().startsWith('&gt;')) {
          quoted.push(mdInline(lines[i].trim().replace(/^&gt;\s?/, '')));
          i++;
        }
        html += '<blockquote class="chat-md-quote">' + quoted.join('<br>') + '</blockquote>';
        continue;
      }

      const ol = trimmed.match(/^(\d+)\.\s+(.*)$/);
      const ul = !ol && trimmed.match(/^[-*]\s+(.*)$/);
      if (ol || ul) {
        const type = ol ? 'ol' : 'ul';
        if (!list || list.type !== type) { closeList(); list = { type, items: '' }; }
        list.items += '<li>' + mdInline(ol ? ol[2] : ul[1]) + '</li>';
        i++; continue;
      }

      closeList();
      const para = [line];
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t === '' || /^@@CB\d+@@$/.test(t) || /^#{1,6}\s+/.test(t) ||
            /^(-{3,}|\*{3,}|_{3,})$/.test(t) || t.startsWith('&gt;') ||
            /^\d+\.\s+/.test(t) || /^[-*]\s+/.test(t)) break;
        para.push(lines[i]);
        i++;
      }
      html += '<p class="chat-md-p">' + para.map(l => mdInline(l.trim())).join('<br>') + '</p>';
    }
    closeList();
    return html || mdInline(src);
  }

  function chatBubble(role, text) {
    const d = document.createElement('div');
    d.className = 'chat-bubble ' + role;
    d.innerHTML = role === 'assistant' ? renderRichText(text) : esc(text);
    return d;
  }

  function chatToolRow(m) {
    const d = document.createElement('div');
    d.className = 'chat-tool-row';
    d.innerHTML = '<span class="chat-tool-dot"></span><span class="chat-tool-name mono">' + esc(m.text) + '</span>' +
      (m.detail ? '<span class="chat-tool-detail mono" title="' + esc(m.detail) + '">' + esc(m.detail) + '</span>' : '');
    return d;
  }

  function chatResultDivider(m) {
    const d = document.createElement('div');
    d.className = 'chat-result-divider' + (m.isError ? ' err' : '');
    const bits = [];
    if (typeof m.cost === 'number') bits.push('$' + m.cost.toFixed(4));
    if (typeof m.turns === 'number') bits.push(m.turns + (m.turns === 1 ? ' turn' : ' turns'));
    const label = (m.isError ? 'turn ended · error' : 'turn complete') + (bits.length ? ' · ' + bits.join(' · ') : '');
    d.innerHTML = '<span>' + esc(label) + '</span>';
    return d;
  }

  function chatNodesFor(m) {
    if (m.kind === 'tool') return [chatToolRow(m)];
    // Fix: the result node renders ONLY the divider — the reply text was
    // already rendered by the preceding assistant/text event in this same
    // turn, so re-rendering it here would print every reply twice.
    if (m.kind === 'result') return [chatResultDivider(m)];
    return [chatBubble(m.role === 'user' ? 'user' : 'assistant', m.text || '')];
  }

  function appendChatNode(node) {
    const empty = chatTranscript.querySelector('.chat-empty');
    if (empty) empty.remove();
    chatTranscript.appendChild(node);
    autoscrollChat();
  }

  function autoscrollChat() {
    if (!chatScrolledUp) chatTranscript.scrollTop = chatTranscript.scrollHeight;
  }

  function appendChatMessages(msgs) {
    for (const m of msgs) for (const n of chatNodesFor(m)) appendChatNode(n);
  }

  chatTranscript.addEventListener('scroll', () => {
    const gap = chatTranscript.scrollHeight - chatTranscript.scrollTop - chatTranscript.clientHeight;
    chatScrolledUp = gap > 40;
  });

  // ---- compose / send ----

  function autosizeChatInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  }
  chatInput.addEventListener('input', autosizeChatInput);

  async function sendChatMessage() {
    const text = chatInput.value;
    if (!text.trim() || chatSendBtn.disabled) return;
    const agent = chatAgent;
    chatInput.value = '';
    autosizeChatInput();
    appendChatMessages([{ role: 'user', kind: 'text', text }]);
    chatSendBtn.disabled = true;
    try {
      const r = await fetch(baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: agent, text }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) showChatError(data.error || 'send failed (' + r.status + ')');
      else showChatError('');
    } catch (e) {
      showChatError('could not reach dashboard server');
    } finally {
      chatSendBtn.disabled = false;
    }
  }
  chatSendBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // ---- public API (C2 items 3-5) ----

  function open() {
    chatOpen = true;
    if (chatPanel) {
      chatPanel.classList.toggle('open', true);
      chatPanel.setAttribute('aria-hidden', 'false');
    }
    if (chatToggle) chatToggle.setAttribute('aria-expanded', 'true');
    backfillChat();
  }

  function close() {
    chatOpen = false;
    if (chatPanel) {
      chatPanel.classList.toggle('open', false);
      chatPanel.setAttribute('aria-hidden', 'true');
    }
    if (chatToggle) chatToggle.setAttribute('aria-expanded', 'false');
    closeChatStream();
  }

  function setAgent(name) {
    if (!AGENTS.includes(name)) return;
    chatAgentSel.value = name;
    chatAgent = name;
    chatInput.placeholder = 'Message ' + chatAgent + '…';
    streamCursor = 0;
    chatScrolledUp = false;
    chatTranscript.innerHTML = '<div class="chat-empty">No messages yet.</div>';
    showChatError('');
    closeChatStream();
    if (chatOpen) backfillChat();
  }

  function destroy() {
    closeChatStream();
  }

  return { open, close, setAgent, destroy };
}
