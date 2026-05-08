const MAX_LINES = 100000;
const LINE_HEIGHT = 28;

const $ = (id) => document.getElementById(id);

const ui = {
  app: document.querySelector(".app"),
  baudRate: $("baudRate"),
  dataBits: $("dataBits"),
  parity: $("parity"),
  stopBits: $("stopBits"),
  displayMode: $("displayMode"),
  markerRegex: $("markerRegex"),
  connectToggleBtn: $("connectToggleBtn"),
  clearBtn: $("clearBtn"),
  autoSave: $("autoSave"),
  timeStamp: $("timeStamp"),
  terminal: $("terminal"),
  lines: $("lines"),
  statusText: $("statusText"),
  statusPort: $("statusPort"),
  statusBaud: $("statusBaud"),
  statusFormat: $("statusFormat"),
  savePath: $("savePath"),
  runtime: $("runtime"),
};

const state = {
  port: null,
  reader: null,
  writer: null,
  reading: false,
  connectedAt: 0,
  carry: "",
  currentLine: null,
  pendingCR: false,
  lines: [],
  stickToBottom: true,
  portLabel: "--",
  markerPattern: "",
  markerRegex: null,
  saveRoot: null,
  saveWritable: null,
  saveQueue: [],
  saveDraining: false,
  saveWanted: false,
};

const decoder = new TextDecoder("utf-8", { fatal: false });

wireEvents();
updateFormat();
updateSaveCapability();
compileMarker();
showEmpty();
setInterval(updateMetrics, 500);

function wireEvents() {
  ui.connectToggleBtn.addEventListener("click", toggleConnection);
  ui.clearBtn.addEventListener("click", clearLog);
  ui.autoSave.addEventListener("change", toggleAutoSave);
  ui.displayMode.addEventListener("change", changeDisplayMode);
  ui.markerRegex.addEventListener("input", () => {
    compileMarker();
    rerenderAll();
  });
  ui.terminal.addEventListener("scroll", handleTerminalScroll, { passive: true });

  for (const el of [ui.dataBits, ui.parity, ui.stopBits, ui.baudRate]) {
    el.addEventListener("change", updateFormat);
  }

  ui.baudRate.addEventListener("input", updateFormat);
  ui.timeStamp.addEventListener("change", rerenderAll);

  window.addEventListener("beforeunload", () => {
    if (state.saveWritable) state.saveWritable.close().catch(() => {});
  });

  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.target === state.port) disconnect();
    });
  }
}

async function toggleConnection() {
  if (state.reading) {
    await disconnect();
    return;
  }

  try {
    await connect();
  } catch (error) {
    setConnected(false);
    setStatus(error.name === "NotFoundError" ? "未选择端口" : "连接失败");
  }
}

async function connect() {
  if (!("serial" in navigator)) {
    setStatus("当前浏览器不支持 Web Serial");
    return;
  }

  const baudRate = Number(ui.baudRate.value);
  if (!Number.isInteger(baudRate) || baudRate <= 0) {
    setStatus("波特率无效");
    return;
  }

  state.port = await navigator.serial.requestPort();

  const options = {
    baudRate,
    dataBits: Number(ui.dataBits.value),
    stopBits: Number(ui.stopBits.value),
    parity: ui.parity.value,
    bufferSize: 1024 * 1024,
    flowControl: "none",
  };

  await state.port.open(options);
  state.reader = state.port.readable.getReader();
  state.writer = state.port.writable?.getWriter() || null;
  clearLog();
  state.reading = true;
  state.connectedAt = performance.now();
  state.portLabel = portName(state.port);
  setConnected(true);

  if (state.saveWanted) await openNewLogFile();

  readLoop();
}

async function readLoop() {
  while (state.reading && state.reader) {
    try {
      const { value, done } = await state.reader.read();
      if (done) break;
      if (value) ingestChunk(value);
    } catch {
      if (state.reading) setStatus("读取中断");
      break;
    }
  }

  if (state.reading) disconnect();
}

function ingestChunk(bytes) {
  if (ui.displayMode.value === "hex") {
    addCompleteLine({ time: nowTime(), level: "", message: bytesToHex(bytes) });
    return;
  }

  ingestAsciiText(decoder.decode(bytes, { stream: true }));
}

function ingestAsciiText(text) {
  for (const char of text) {
    if (state.pendingCR) {
      if (char === "\n") {
        finishAsciiLine({ force: true });
        state.pendingCR = false;
        continue;
      }

      finishAsciiLine({ force: true });
      state.pendingCR = false;
    }

    if (char === "\r") {
      state.pendingCR = true;
      continue;
    }

    if (char === "\n") {
      finishAsciiLine({ force: true });
      continue;
    }

    appendAsciiSegment(char);
  }
}

function appendAsciiSegment(segment) {
  state.carry += segment;

  if (!state.currentLine) {
    state.currentLine = makeDisplayLine(state.carry);
    addLine(state.currentLine, { save: false });
    return;
  }

  updateDisplayLine(state.currentLine, state.carry);
  updateLineElement(state.currentLine);
  keepBottomIfNeeded();
}

function finishAsciiLine(options = {}) {
  if (!state.carry && !state.currentLine && !options.force) return;

  if (!state.currentLine) {
    state.currentLine = makeDisplayLine(state.carry);
    addLine(state.currentLine, { save: false });
  } else {
    updateDisplayLine(state.currentLine, state.carry);
    updateLineElement(state.currentLine);
  }

  queueAutoSave([state.currentLine]);
  state.currentLine = null;
  state.carry = "";
  keepBottomIfNeeded();
}

function addCompleteLine(item) {
  addLine(item, { save: true });
}

function addLine(item, options = {}) {
  const shouldFollow = state.stickToBottom || isNearBottom();

  state.lines.push(item);
  if (state.lines.length === 1) ui.lines.textContent = "";

  const el = createLineElement(item);
  item.el = el;
  ui.lines.appendChild(el);

  if (options.save !== false) queueAutoSave([item]);

  while (state.lines.length > MAX_LINES) {
    const removed = state.lines.shift();
    removed?.el?.remove();
  }

  if (shouldFollow) scrollToBottom();
}

function makeDisplayLine(text) {
  const { level, message } = parseLevel(text);
  return { time: nowTime(), level, message, raw: text };
}

function updateDisplayLine(line, text) {
  const { level, message } = parseLevel(text);
  line.level = level;
  line.message = message;
  line.raw = text;
}

function parseLevel(text) {
  const match = /\b(INFO|WARN|WARNING|ERROR|ERR|DEBUG|TRACE)\b[:\]\s-]*/i.exec(text);
  if (!match) return { level: "", message: text };

  const level = normalizeLevel(match[1]);
  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length);
  return { level, message: after || before || text };
}

function normalizeLevel(level) {
  const value = level.toUpperCase();
  if (value === "ERR") return "ERROR";
  if (value === "WARNING") return "WARN";
  return value;
}

function changeDisplayMode() {
  finishAsciiLine({ force: state.pendingCR });
  state.pendingCR = false;
  setStatus(state.reading ? "已连接" : "未连接");
}

function compileMarker() {
  state.markerPattern = ui.markerRegex.value;
  state.markerRegex = null;

  if (!state.markerPattern) {
    ui.markerRegex.title = "";
    ui.markerRegex.classList.remove("invalid");
    return;
  }

  try {
    state.markerRegex = new RegExp(state.markerPattern, "g");
    ui.markerRegex.title = "";
    ui.markerRegex.classList.remove("invalid");
  } catch (error) {
    ui.markerRegex.title = error.message;
    ui.markerRegex.classList.add("invalid");
    setStatus("正则无效");
  }
}

function createLineElement(item) {
  const el = document.createElement("div");
  updateLineElement(item, el);
  return el;
}

function updateLineElement(item, existingEl = item.el) {
  if (!existingEl) return;

  const showTime = ui.timeStamp.checked;
  const message = markText(item.message);

  if (showTime && item.level) {
    existingEl.className = "line";
    existingEl.innerHTML = `<span class="time">[${item.time}]</span><span class="level level-${item.level.toLowerCase()}">${item.level}</span><span class="message">${message}</span>`;
  } else if (showTime) {
    existingEl.className = "line no-level";
    existingEl.innerHTML = `<span class="time">[${item.time}]</span><span class="message">${message}</span>`;
  } else if (item.level) {
    existingEl.className = "line no-time";
    existingEl.innerHTML = `<span class="level level-${item.level.toLowerCase()}">${item.level}</span><span class="message">${message}</span>`;
  } else {
    existingEl.className = "line raw";
    existingEl.innerHTML = `<span class="message">${message}</span>`;
  }
}

function rerenderAll() {
  const shouldFollow = state.stickToBottom || isNearBottom();
  const fragment = document.createDocumentFragment();

  if (!state.lines.length) {
    showEmpty();
    return;
  }

  for (const item of state.lines) {
    const el = createLineElement(item);
    item.el = el;
    fragment.appendChild(el);
  }

  ui.lines.replaceChildren(fragment);
  if (shouldFollow) scrollToBottom();
}

function markText(value) {
  const pieces = visiblePieces(value);
  if (!state.markerRegex) return renderVisiblePieces(pieces, []);

  const regex = state.markerRegex;
  regex.lastIndex = 0;
  const markRanges = [];
  let match;

  while ((match = regex.exec(value)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    markRanges.push({ start, end });

    if (match[0].length === 0) regex.lastIndex += 1;
  }

  return renderVisiblePieces(pieces, markRanges);
}

function visiblePieces(value) {
  const pieces = [];
  let rawIndex = 0;
  let textBuffer = "";
  let textStart = 0;

  for (const char of value) {
    const label = controlLabel(char);
    if (!label) {
      if (!textBuffer) textStart = rawIndex;
      textBuffer += char;
      rawIndex += char.length;
      continue;
    }

    pushVisiblePiece(pieces, textBuffer, false, textStart, rawIndex);
    textBuffer = "";
    pushVisiblePiece(pieces, label, true, rawIndex, rawIndex + char.length);
    rawIndex += char.length;
  }

  pushVisiblePiece(pieces, textBuffer, false, textStart, rawIndex);
  return pieces;
}

function pushVisiblePiece(pieces, text, control, rawStart, rawEnd) {
  if (!text) return;

  pieces.push({
    text,
    control,
    rawStart,
    rawEnd,
  });
}

function renderVisiblePieces(pieces, markRanges) {
  let rangeIndex = 0;
  let output = "";

  for (const piece of pieces) {
    let cursor = piece.rawStart;

    while (cursor < piece.rawEnd) {
      while (rangeIndex < markRanges.length && markRanges[rangeIndex].end <= cursor) {
        rangeIndex += 1;
      }

      const range = markRanges[rangeIndex];
      const marked = Boolean(range && range.start <= cursor && range.end > cursor);
      const nextBoundary = marked ? range.end : (range?.start ?? piece.rawEnd);
      const next = Math.min(piece.rawEnd, nextBoundary);
      const text = piece.control
        ? piece.text
        : piece.text.slice(cursor - piece.rawStart, next - piece.rawStart);

      output += renderVisibleSegment(text, piece.control, marked);
      cursor = next;
    }
  }

  return output;
}

function renderVisibleSegment(text, control, marked) {
  if (!control && !marked) return escapeHtml(text);

  const classes = [];
  if (control) classes.push("control-char");
  if (marked) classes.push("mark");
  return `<span class="${classes.join(" ")}">${escapeHtml(text)}</span>`;
}

async function disconnect() {
  state.reading = false;
  finishAsciiLine({ force: state.pendingCR });
  state.pendingCR = false;

  try {
    await state.reader?.cancel();
  } catch {}

  try {
    state.reader?.releaseLock();
  } catch {}

  try {
    state.writer?.releaseLock();
  } catch {}

  try {
    if (state.port?.readable || state.port?.writable) await state.port.close();
  } catch {
    setStatus("断开异常");
  }

  await closeLogFile();

  state.reader = null;
  state.writer = null;
  state.port = null;
  setConnected(false);
}

function clearLog() {
  state.lines.length = 0;
  state.carry = "";
  state.currentLine = null;
  state.pendingCR = false;
  state.stickToBottom = true;
  ui.terminal.scrollTop = 0;
  showEmpty();
}

function showEmpty() {
  ui.lines.innerHTML = '<div class="empty">等待串口数据</div>';
}

async function toggleAutoSave() {
  if (!ui.autoSave.checked) {
    state.saveWanted = false;
    await closeLogFile();
    setSavePath("未开启");
    return;
  }

  try {
    if (!state.saveRoot) {
      state.saveRoot = await window.showDirectoryPicker({ mode: "readwrite" });
    }

    state.saveWanted = true;
    setSavePath(state.reading ? "准备保存..." : `${state.saveRoot.name}\\等待连接`);

    if (state.reading) {
      await openNewLogFile();
    }
  } catch (error) {
    ui.autoSave.checked = false;
    state.saveWanted = false;
    if (error.name !== "AbortError") setStatus("选择目录失败");
    setSavePath("未开启");
  }
}

function updateSaveCapability() {
  if ("showDirectoryPicker" in window) {
    setSavePath("未开启");
    return;
  }

  ui.autoSave.checked = false;
  ui.autoSave.disabled = true;
  setSavePath("浏览器不支持");
}

async function openNewLogFile() {
  if (!state.saveWanted || !state.saveRoot) return;

  await closeLogFile(false);
  const fileName = `${fileTime(new Date())}.log`;
  const fileHandle = await state.saveRoot.getFileHandle(fileName, { create: true });
  state.saveWritable = await fileHandle.createWritable({ keepExistingData: false });
  state.saveQueue.length = 0;
  setSavePath(`${state.saveRoot.name}\\${fileName}`);
}

async function closeLogFile(clearPath = true) {
  await drainAutoSave();

  if (state.saveWritable) {
    try {
      await state.saveWritable.close();
    } catch {}
  }

  state.saveWritable = null;
  state.saveQueue.length = 0;

  if (clearPath && state.saveWanted && state.saveRoot) {
    setSavePath(`${state.saveRoot.name}\\等待连接`);
  }
}

function queueAutoSave(lines) {
  if (!state.saveWritable || !lines.length) return;
  state.saveQueue.push(linesToText(lines));
  drainAutoSave();
}

async function drainAutoSave() {
  if (state.saveDraining || !state.saveWritable) return;
  state.saveDraining = true;

  try {
    while (state.saveQueue.length && state.saveWritable) {
      await state.saveWritable.write(state.saveQueue.shift());
    }
  } catch {
    state.saveWanted = false;
    ui.autoSave.checked = false;
    setSavePath("保存失败");
    setStatus("保存失败");
  } finally {
    state.saveDraining = false;
  }
}

function linesToText(lines) {
  return lines.map((item) => {
    const level = item.level ? `${item.level} ` : "";
    return `[${item.time}] ${level}${visualizeControls(item.message)}`;
  }).join("\n") + "\n";
}

function setSavePath(text) {
  ui.savePath.textContent = text;
  ui.savePath.title = text;
}

function setConnected(connected) {
  ui.app.dataset.connected = String(connected);
  ui.connectToggleBtn.textContent = connected ? "断开" : "连接";
  ui.connectToggleBtn.classList.toggle("btn-primary", !connected);
  ui.connectToggleBtn.classList.toggle("btn-danger", connected);
  ui.baudRate.disabled = connected;
  ui.dataBits.disabled = connected;
  ui.parity.disabled = connected;
  ui.stopBits.disabled = connected;
  setStatus(connected ? "已连接" : "未连接");
  ui.statusPort.textContent = connected ? state.portLabel : "--";
}

function setStatus(text) {
  ui.statusText.textContent = text;
}

function updateFormat() {
  const parity = ui.parity.value === "none" ? "N" : ui.parity.value[0].toUpperCase();
  ui.statusBaud.textContent = ui.baudRate.value || "--";
  ui.statusFormat.textContent = `${ui.dataBits.value}-${parity}-${ui.stopBits.value}`;
}

function updateMetrics() {
  if (!state.connectedAt || !state.reading) {
    ui.runtime.textContent = "00:00:00";
    return;
  }

  const elapsed = Math.max(0, performance.now() - state.connectedAt);
  ui.runtime.textContent = formatDuration(elapsed);
}

function portName(port) {
  const info = port.getInfo?.() || {};
  if (info.usbVendorId || info.usbProductId) {
    const vendor = hex(info.usbVendorId);
    const product = hex(info.usbProductId);
    return `USB ${vendor}:${product}`;
  }
  return "串口";
}

function nowTime() {
  const d = new Date();
  const pad = (num, len = 2) => String(num).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fileTime(d) {
  const pad = (num, len = 2) => String(num).padStart(len, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function bytesToHex(bytes) {
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) output += " ";
    output += bytes[i].toString(16).padStart(2, "0").toUpperCase();
  }
  return output;
}

function visualizeControls(value) {
  return value.replace(/[\u0000-\u001F\u007F]/g, (char) => controlLabel(char));
}

function controlLabel(char) {
  if (char === "\r") return "<CR>";
  if (char === "\n") return "<LF>";
  if (char === "\t") return "<TAB>";

  const code = char.charCodeAt(0);
  if (code > 0x1F && code !== 0x7F) return "";
  if (code === 0x7F) return "<DEL>";
  return `<${code.toString(16).toUpperCase().padStart(2, "0")}>`;
}

function hex(value) {
  return value == null ? "----" : value.toString(16).padStart(4, "0").toUpperCase();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function scrollToBottom() {
  ui.terminal.scrollTop = ui.terminal.scrollHeight;
}

function keepBottomIfNeeded() {
  if (state.stickToBottom || isNearBottom()) scrollToBottom();
}

function handleTerminalScroll() {
  state.stickToBottom = isNearBottom();
}

function isNearBottom() {
  const distance = ui.terminal.scrollHeight - ui.terminal.scrollTop - ui.terminal.clientHeight;
  return distance <= LINE_HEIGHT * 1.5;
}
