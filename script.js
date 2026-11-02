'use strict';

const input = document.querySelector('#input');
const output = document.querySelector('#output');
const copy = document.querySelector('#copy');
const status = document.querySelector('#status');
const loading = document.querySelector('#loading');
const formatButton = document.querySelector('#format');
const editors = document.querySelector('.editors');
const divider = document.querySelector('#divider');
let result = '';
let copyTimer;
let activeWorker;
let generation = 0;
let outputData = null;
let visibleLines = [];
const collapsed = new Set();
const outputBody = document.querySelector('#output-body');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
document.querySelector('.shortcut').textContent = isMac ? '⌘ ↵' : 'Ctrl ↵';

// A Blob worker also works when the static site is opened directly from disk.
function processor() {
  // Parse a limited, forgiving data grammar. Never execute pasted content.
  function repair(source) {
    let text = source.trim().replace(/^\uFEFF/, '');
    let extracted = false;
    const fence = text.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    if (!/^[{["'\d\-]/.test(text) && !/^(?:true|false|null|True|False|None)\b/.test(text)) {
      const start = text.search(/[\[{]/);
      if (start < 0) throw new Error('No JSON value found.');
      text = text.slice(start);
      extracted = true;
    }
    let pos = 0;
    let depth = 0;
    function error(message) { throw new Error(`${message} at position ${pos}.`); }
    function skip() {
      while (pos < text.length) {
        if (/\s/.test(text[pos])) { pos++; continue; }
        if (text.startsWith('//', pos)) {
          const end = text.indexOf('\n', pos + 2);
          pos = end < 0 ? text.length : end + 1;
        } else if (text.startsWith('/*', pos)) {
          const end = text.indexOf('*/', pos + 2);
          if (end < 0) error('Unclosed comment');
          pos = end + 2;
        } else break;
      }
    }
    function string() {
      const quote = text[pos++];
      let value = '';
      while (pos < text.length) {
        let char = text[pos++];
        if (char === quote) return value;
        if (char !== '\\') { value += char; continue; }
        if (pos >= text.length) error('Incomplete escape');
        char = text[pos++];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
        if (char === 'u') {
          const hex = text.slice(pos, pos + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) error('Invalid Unicode escape');
          value += String.fromCharCode(parseInt(hex, 16));
          pos += 4;
        } else if (Object.hasOwn(escapes, char)) value += escapes[char];
        else error('Invalid escape');
      }
      error('Unclosed string');
    }
    function value() {
      skip();
      if (++depth > 500) error('JSON nesting is too deep to repair');
      let result;
      const char = text[pos];
      if (char === '{' || char === '[') {
        const object = char === '{';
        const close = object ? '}' : ']';
        result = object ? Object.create(null) : [];
        const keys = new Set();
        pos++;
        skip();
        while (pos < text.length && text[pos] !== close) {
          if (text[pos] === '}' || text[pos] === ']') error('Mismatched closing bracket');
          let key;
          if (object) {
            if (text[pos] === '"' || text[pos] === "'") key = string();
            else {
              const match = text.slice(pos).match(/^[A-Za-z_$][\w$-]*/);
              if (!match) error('Expected an object key');
              key = match[0]; pos += key.length;
            }
            if (keys.has(key)) error(`Duplicate key ${JSON.stringify(key)}`);
            keys.add(key);
            skip();
            if (text[pos++] !== ':') error('Expected a colon after the key');
          }
          const item = value();
          if (object) result[key] = item;
          else result.push(item);
          skip();
          if (text[pos] === ',') { pos++; skip(); }
          else if (pos < text.length && text[pos] !== close) {
            // Only infer a missing comma where the next value is unambiguous.
            if (!/["'{[\d\-A-Za-z_$]/.test(text[pos])) error('Expected a comma');
          }
        }
        if (text[pos] === close) pos++;
        // End-of-input closes containers only after complete entries.
      } else if (char === '"' || char === "'") result = string();
      else {
        const token = text.slice(pos).match(/^(?:true|false|null|True|False|None)(?![\w$])|^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (!token) error('Expected a JSON value');
        pos += token[0].length;
        const literals = { true: true, false: false, null: null, True: true, False: false, None: null };
        result = Object.hasOwn(literals, token[0]) ? literals[token[0]] : Number(token[0]);
        if (typeof result === 'number' && !Number.isFinite(result)) error('Number is out of range');
        if (/[\w.$+\-]/.test(text[pos] || ' ')) error('Invalid value');
      }
      depth--;
      return result;
    }
    const result = value();
    skip();
    // Permit a prose suffix, but reject extra JSON values and broken punctuation.
    const suffix = text.slice(pos).trim();
    if (suffix && (!extracted || !/^[A-Za-z][A-Za-z\s.,!?():'"-]*$/.test(suffix))) error('Unexpected content after JSON');
    return result;
  }
  self.onmessage = ({ data }) => {
    try {
      let parsed;
      let repaired = false;
      try { parsed = JSON.parse(data); }
      catch { parsed = repair(data); repaired = true; }
      const text = JSON.stringify(parsed, null, 2);
      const lineCount = text.split('\n').length;
      const rows = text.split('\n');
      const ends = {};
      const stack = [];
      rows.forEach((line, index) => {
        if (/^[}\]]/.test(line.trimStart())) ends[stack.pop()] = index;
        if (/[{\[]$/.test(line)) stack.push(index);
      });
      self.postMessage({ text, rows, ends, lineCount, repaired, bytes: new TextEncoder().encode(text).length });
    } catch (error) {
      self.postMessage({ error: error.message });
    }
  };
}
const workerURL = URL.createObjectURL(new Blob([`(${processor.toString()})()`], { type: 'text/javascript' }));
function setStatus(message, state = '') {
  status.className = `status ${state}`;
  status.hidden = !message;
  document.querySelector('#status-message').textContent = message;
}
function lineNumbers(count) {
  // Keep huge line-number gutters from becoming another expensive document.
  return count <= 10000 ? Array.from({ length: count }, (_, i) => i + 1).join('\n') : '';
}
function stopProcessing() {
  generation++;
  activeWorker?.terminate();
  activeWorker = null;
  loading.hidden = true;
  formatButton.disabled = false;
  document.querySelector('.output-pane').setAttribute('aria-busy', 'false');
}
function resetOutput() {
  document.querySelector('#output-placeholder').hidden = false;
  result = '';
  outputData = null;
  visibleLines = [];
  collapsed.clear();
  output.style.height = '';
  output.style.paddingTop = '';
  const gutter = document.querySelector('#output-lines');
  gutter.style.height = '';
  gutter.style.paddingTop = '';
  output.replaceChildren();
  document.querySelector('#output-lines').textContent = '';
  document.querySelector('#output-stats').textContent = '';
  document.querySelector('#valid-indicator').textContent = '';
  copy.disabled = true;
  if (findState.scope === 'output') refreshFind();
  clearTimeout(copyTimer);
  copy.classList.remove('copied');
  copy.setAttribute('aria-label', 'Copy JSON');
  copy.title = 'Copy JSON';
  document.querySelector('#copy-label').textContent = '';
}
function updateInput() {
  stopProcessing();
  const text = input.value;
  const count = text.length < 200000 ? text.split('\n').length : 10001;
  document.querySelector('#input-lines').textContent = lineNumbers(count);
  document.querySelector('#input-stats').textContent = `${text.length.toLocaleString()} characters`;
  input.removeAttribute('aria-invalid');
  setStatus('');
  resetOutput();
  if (findState.scope === 'input') refreshFind();
}
function rebuildVisibleLines() {
  visibleLines = [];
  for (let i = 0; i < outputData.rows.length; i++) {
    visibleLines.push(i);
    if (collapsed.has(i)) i = outputData.ends[i];
  }
}
function highlightLine(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g, (match, string, literal) => {
            const type = string ? (/:$/.test(string) ? 'key' : 'string') : literal ? (literal === 'null' ? 'null' : 'boolean') : 'number';
            return `<span class="json-${type}">${match}</span>`;
          });
}
function paintOutput() {
  if (!outputData) return;
  const start = Math.max(0, Math.floor((outputBody.scrollTop - 12) / 24) - 8);
  const end = Math.min(visibleLines.length, start + Math.ceil(outputBody.clientHeight / 24) + 18);
  const height = visibleLines.length * 24 + 32;
  const gutter = document.querySelector('#output-lines');
  output.style.height = gutter.style.height = `${height}px`;
  output.style.paddingTop = gutter.style.paddingTop = `${12 + start * 24}px`;
  const fragment = document.createDocumentFragment();
  const numbers = [];
  for (let row = start; row < end; row++) {
    const index = visibleLines[row];
    const line = document.createElement('span');
    line.className = 'json-row';
    const foldEnd = outputData.ends[index];
    if (foldEnd !== undefined) {
      const button = document.createElement('button');
      button.className = 'fold-button';
      button.style.setProperty('--indent', outputData.rows[index].length - outputData.rows[index].trimStart().length);
      button.dataset.line = index;
      button.setAttribute('aria-expanded', String(!collapsed.has(index)));
      button.setAttribute('aria-label', `${collapsed.has(index) ? 'Expand' : 'Collapse'} line ${index + 1}`);
      line.append(button);
    }
    const content = document.createElement('span');
    content.innerHTML = highlightLine(outputData.rows[index]);
    markOutputMatches(content, index);
    line.append(content);
    if (collapsed.has(index)) {
      const summary = document.createElement('span');
      summary.className = 'fold-summary';
      summary.textContent = ` … ${outputData.rows[foldEnd].trimStart()}`;
      line.append(summary);
    }
    fragment.append(line);
    numbers.push(index + 1);
  }
  output.replaceChildren(fragment);
  gutter.textContent = numbers.join('\n');
}
async function render(data, job) {
  if (job !== generation) return;
  document.querySelector('#output-placeholder').hidden = true;
  result = data.text;
  outputData = data;
  collapsed.clear();
  rebuildVisibleLines();
  outputBody.scrollTop = 0;
  if (findState.scope === 'output') refreshFind();
  paintOutput();
  document.querySelector('#output-stats').textContent = `${data.lineCount.toLocaleString()} lines · ${data.bytes.toLocaleString()} bytes`;
  document.querySelector('#valid-indicator').textContent = data.repaired ? '✓ Repaired JSON' : '✓ Valid JSON';
  copy.disabled = false;
  stopProcessing();
}
outputBody.addEventListener('scroll', paintOutput);
output.addEventListener('click', (event) => {
  const button = event.target.closest('.fold-button');
  if (!button || !outputData) return;
  const index = Number(button.dataset.line);
  if (collapsed.has(index)) collapsed.delete(index);
  else collapsed.add(index);
  rebuildVisibleLines();
  // Clamp before painting when collapsing shortens the scrollable document.
  outputBody.scrollTop = Math.min(outputBody.scrollTop, Math.max(0, visibleLines.length * 24 + 32 - outputBody.clientHeight));
  paintOutput();
  output.querySelector(`[data-line="${index}"]`)?.focus({ preventScroll: true });
});
new ResizeObserver(paintOutput).observe(outputBody);
function format() {
  stopProcessing();
  resetOutput();
  setStatus('');
  if (!input.value.trim()) {
    setStatus('Paste JSON to format.');
    input.focus();
    return;
  }
  loading.hidden = false;
  formatButton.disabled = true;
  document.querySelector('.output-pane').setAttribute('aria-busy', 'true');
  const job = generation;
  try {
    activeWorker = new Worker(workerURL);
    activeWorker.onmessage = async ({ data }) => {
      if (job !== generation) return;
      if (data.error) {
        input.setAttribute('aria-invalid', 'true');
        setStatus(`Invalid JSON: ${data.error}`, 'error');
        stopProcessing();
      } else {
        input.removeAttribute('aria-invalid');
        try { await render(data, job); } catch (error) { fail(error.message); }
      }
    };
    activeWorker.onerror = () => { if (job === generation) fail('Unable to process JSON. Try a smaller input.'); };
    activeWorker.postMessage(input.value);
  } catch (error) { fail(error.message); }
}
function fail(message) {
  stopProcessing();
  resetOutput();
  setStatus(message, 'error');
}
input.addEventListener('input', updateInput);
input.addEventListener('paste', (event) => {
  if (!event.clipboardData?.getData('text/plain')) return;
  // Wait for the browser's paste and input events before confirming the paste.
  requestAnimationFrame(() => setStatus('Pasted successfully.', 'success'));
});
input.addEventListener('scroll', () => {
  document.querySelector('#input-lines').scrollTop = input.scrollTop;
});
formatButton.addEventListener('click', format);
document.querySelector('#cancel').addEventListener('click', () => {
  stopProcessing();
  resetOutput();
});
document.querySelector('#clear').addEventListener('click', () => {
  input.value = '';
  updateInput();
  input.focus();
});
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(result);
    copy.classList.add('copied');
    copy.setAttribute('aria-label', 'Copied');
    copy.title = 'Copied';
    document.querySelector('#copy-label').textContent = 'Copied';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copy.classList.remove('copied');
      copy.setAttribute('aria-label', 'Copy JSON');
      copy.title = 'Copy JSON';
      document.querySelector('#copy-label').textContent = '';
    }, 1800);
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = result;
    temporary.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    if (!copied) setStatus('Copy unavailable. Allow clipboard access in your browser.', 'error');
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!activeWorker) format();
  }
});
const dividerStorageKey = 'json-formatter:divider';
function resize(percent, persist = true) {
  if (!Number.isFinite(percent)) return;
  const value = Math.max(20, Math.min(80, percent));
  editors.style.setProperty('--input-width', `${value}%`);
  divider.setAttribute('aria-valuenow', String(Math.round(value)));
  if (persist) {
    try { localStorage.setItem(dividerStorageKey, String(value)); } catch {}
  }
}
try {
  const saved = localStorage.getItem(dividerStorageKey);
  if (saved !== null && saved.trim() !== '') resize(Number(saved), false);
} catch {}
let dragging = false;
divider.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  divider.setPointerCapture(event.pointerId);
  document.body.classList.add('resizing');
  event.preventDefault();
});
divider.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const bounds = editors.getBoundingClientRect();
  resize((event.clientX - bounds.left) / bounds.width * 100);
});
function endDrag() {
  dragging = false;
  document.body.classList.remove('resizing');
}
divider.addEventListener('pointerup', endDrag);
divider.addEventListener('lostpointercapture', endDrag);
divider.addEventListener('pointercancel', endDrag);
divider.addEventListener('dblclick', () => resize(50));
divider.addEventListener('keydown', (event) => {
  let value = Number(divider.getAttribute('aria-valuenow'));
  if (event.key === 'ArrowLeft') value -= 2;
  else if (event.key === 'ArrowRight') value += 2;
  else if (event.key === 'Home') value = 20;
  else if (event.key === 'End') value = 80;
  else return;
  event.preventDefault();
  resize(value);
});


// Search the source data, including rows outside the virtualized viewport.
const findState = { scope: 'input', matches: [], current: -1 };
let lastEditor = 'input';
const findBar = document.createElement('div');
findBar.className = 'find-bar';
findBar.hidden = true;
findBar.setAttribute('role', 'search');
findBar.innerHTML = `
  <input id="find-query" type="text" placeholder="Find…" autocomplete="off" spellcheck="false">
  <span id="find-count" role="status" aria-live="polite"></span>
  <button type="button" id="find-previous" aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button>
  <button type="button" id="find-next" aria-label="Next match" title="Next match (Enter)">↓</button>
  <button type="button" id="find-close" aria-label="Close search" title="Close search (Escape)">×</button>`;
const findQuery = findBar.querySelector('#find-query');
const findCount = findBar.querySelector('#find-count');
const findPrevious = findBar.querySelector('#find-previous');
const findNext = findBar.querySelector('#find-next');
// A textarea cannot contain marks; draw their backgrounds in a matching layer.
const inputHighlights = document.createElement('div');
inputHighlights.className = 'input-highlights';
inputHighlights.setAttribute('aria-hidden', 'true');
const inputHighlightText = document.createElement('div');
inputHighlights.append(inputHighlightText);
input.before(inputHighlights);
function syncInputHighlights() {
  inputHighlights.style.width = `${input.clientWidth}px`;
  inputHighlightText.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
}
function paintInputMatches() {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  if (!findBar.hidden && findState.scope === 'input') {
    findState.matches.forEach((match, index) => {
      fragment.append(document.createTextNode(input.value.slice(offset, match.start)));
      const mark = document.createElement('mark');
      mark.className = index === findState.current ? 'find-current' : 'find-match';
      mark.textContent = input.value.slice(match.start, match.end);
      fragment.append(mark);
      offset = match.end;
    });
  }
  fragment.append(document.createTextNode(input.value.slice(offset) + '\n'));
  inputHighlightText.replaceChildren(fragment);
  syncInputHighlights();
}
input.addEventListener('scroll', syncInputHighlights);
input.addEventListener('input', paintInputMatches);
new ResizeObserver(syncInputHighlights).observe(input);

document.addEventListener('focusin', (event) => {
  if (findBar.contains(event.target)) return;
  if (event.target.closest('.output-pane')) lastEditor = 'output';
  else if (event.target.closest('.input-pane')) lastEditor = 'input';
});
function updateFindCount() {
  const count = findState.matches.length;
  findCount.textContent = !findQuery.value ? '' : count ? `${findState.current + 1} of ${count}` : 'No matches';
  findPrevious.disabled = findNext.disabled = !count;
}
function refreshFind() {
  findState.matches = [];
  findState.current = -1;
  if (!findBar.hidden && findQuery.value) {
    const rows = findState.scope === 'input' ? [input.value] : (outputData?.rows || []);
    rows.forEach((text, row) => {
      // An escaped literal expression preserves source offsets for Unicode text.
      const escaped = findQuery.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'gi');
      for (const match of text.matchAll(pattern)) {
        findState.matches.push({ row, start: match.index, end: match.index + match[0].length });
      }
    });
    if (findState.matches.length) findState.current = 0;
  }
  updateFindCount();
  paintInputMatches();
  revealFindMatch();
  paintOutput();
}
function revealFindMatch() {
  const match = findState.matches[findState.current];
  if (!match) return;
  if (findState.scope === 'input') {
    // Measure wrapped text using the textarea's exact width and typography.
    const mirror = document.createElement('div');
    const style = getComputedStyle(input);
    for (const property of ['font', 'lineHeight', 'letterSpacing', 'padding', 'boxSizing', 'tabSize', 'wordBreak', 'overflowWrap']) mirror.style[property] = style[property];
    mirror.style.cssText += `;position:fixed;visibility:hidden;white-space:pre-wrap;width:${input.clientWidth}px;`;
    mirror.textContent = input.value.slice(0, match.start);
    const marker = document.createElement('span');
    marker.textContent = input.value.slice(match.start, match.end) || ' ';
    mirror.append(marker);
    document.body.append(mirror);
    input.scrollTop = Math.max(0, marker.offsetTop - input.clientHeight / 2);
    mirror.remove();
    syncInputHighlights();
  } else {
    for (const start of collapsed) {
      if (start < match.row && outputData.ends[start] >= match.row) collapsed.delete(start);
    }
    rebuildVisibleLines();
    const row = visibleLines.indexOf(match.row);
    outputBody.scrollTop = Math.max(0, 12 + row * 24 - outputBody.clientHeight / 2);
    paintOutput();
    output.querySelector('mark.find-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
function moveFind(direction) {
  const count = findState.matches.length;
  if (!count) return;
  findState.current = (findState.current + direction + count) % count;
  updateFindCount();
  paintInputMatches();
  revealFindMatch();
}
function markOutputMatches(content, row) {
  if (findBar.hidden || findState.scope !== 'output') return;
  const needle = findQuery.value;
  if (!needle) return;
  const active = findState.matches[findState.current];
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, offset });
    offset += node.length;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...content.textContent.matchAll(new RegExp(escaped, 'gi'))];
  for (const { node, offset: start } of nodes) {
    const fragment = document.createDocumentFragment();
    let position = 0;
    for (const match of matches) {
      const from = Math.max(0, match.index - start);
      const to = Math.min(node.length, match.index + match[0].length - start);
      if (from >= to) continue;
      fragment.append(document.createTextNode(node.data.slice(position, from)));
      const mark = document.createElement('mark');
      mark.className = active?.row === row && active.start === match.index ? 'find-current' : 'find-match';
      mark.textContent = node.data.slice(from, to);
      fragment.append(mark);
      position = to;
    }
    fragment.append(document.createTextNode(node.data.slice(position)));
    node.replaceWith(fragment);
  }
}
function closeFind() {
  findBar.hidden = true;
  findState.matches = [];
  findState.current = -1;
  paintInputMatches();
  paintOutput();
  (findState.scope === 'input' ? input : output).focus({ preventScroll: true });
}
findQuery.addEventListener('input', refreshFind);
findPrevious.addEventListener('click', () => moveFind(-1));
findNext.addEventListener('click', () => moveFind(1));
findBar.querySelector('#find-close').addEventListener('click', closeFind);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    findState.scope = lastEditor;
    document.querySelector(`.${lastEditor}-pane .pane-header`).after(findBar);
    findBar.hidden = false;
    findQuery.setAttribute('aria-label', `Find in ${lastEditor}`);
    findQuery.focus();
    findQuery.select();
    refreshFind();
  } else if (!findBar.hidden && event.key === 'Escape') {
    event.preventDefault();
    closeFind();
  } else if (!findBar.hidden && findBar.contains(event.target) && event.key === 'Enter') {
    event.preventDefault();
    moveFind(event.shiftKey ? -1 : 1);
  }
}, true);
