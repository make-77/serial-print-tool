const MAX_LINES = 20000;
const LINE_HEIGHT = 28;
const MAX_RENDER_BATCH = 800;
const MAX_HEX_CARRY_LENGTH = 262144;
const HEX_CARRY_RETAIN_LENGTH = 65536;
const MAX_LIVE_LINE_LENGTH = 8192;

const $ = (id) => document.getElementById(id);

const ui = {
  app: document.querySelector(".app"),
  baudRate: $("baudRate"),
  dataBits: $("dataBits"),
  parity: $("parity"),
  stopBits: $("stopBits"),
  displayMode: $("displayMode"),
  markerRegex: $("markerRegex"),
  frameRegexField: document.querySelector(".field-frame-regex"),
  frameRegex: $("frameRegex"),
  connectToggleBtn: $("connectToggleBtn"),
  clearBtn: $("clearBtn"),
  autoSave: $("autoSave"),
  timeStamp: $("timeStamp"),
  terminal: $("terminal"),
  lines: $("lines"),
  jumpToBottomBtn: $("jumpToBottomBtn"),
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
  currentLineDirty: false,
  currentLineScheduled: false,
  pendingCR: false,
  hexCarry: "",
  lines: [],
  renderQueue: [],
  renderScheduled: false,
  pendingFollow: false,
  stickToBottom: true,
  userScrollPaused: false,
  programmaticScroll: false,
  portLabel: "--",
  markerPattern: "",
  markerRegex: null,
  framePattern: "",
  frameRegex: null,
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
compileFrameRegex();
updateModeControls();
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
  ui.frameRegex.addEventListener("input", () => {
    compileFrameRegex();
    if (state.frameRegex) {
      splitHexCarryIntoFrames();
    } else {
      finishHexCarry();
    }
  });
  ui.jumpToBottomBtn.addEventListener("click", () => resumeAutoFollow({ scroll: true }));
  ui.terminal.addEventListener("wheel", handleTerminalWheel, { passive: true });
  ui.terminal.addEventListener("touchstart", pauseAutoFollow, { passive: true });
  ui.terminal.addEventListener("pointerdown", pauseAutoFollow, { passive: true });
  ui.terminal.addEventListener("keydown", handleTerminalKeydown);
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
    ingestHexBytes(bytes);
    return;
  }

  ingestAsciiText(decoder.decode(bytes, { stream: true }));
}

function ingestHexBytes(bytes) {
  const text = bytesToHex(bytes);

  if (!state.frameRegex) {
    addCompleteLine({ time: nowTime(), level: "", message: text });
    return;
  }

  state.hexCarry = state.hexCarry ? `${state.hexCarry} ${text}` : text;
  splitHexCarryIntoFrames();
}

function splitHexCarryIntoFrames() {
  if (!state.hexCarry || !state.frameRegex) return;

  const regex = state.frameRegex;
  regex.lastIndex = 0;

  let match;
  let consumed = 0;

  while ((match = regex.exec(state.hexCarry)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }

    const prefix = cleanHexSegment(state.hexCarry.slice(consumed, match.index));
    if (prefix) addCompleteLine({ time: nowTime(), level: "", message: prefix });

    const frame = cleanHexSegment(match[0]);
    if (frame) addCompleteLine({ time: nowTime(), level: "", message: frame });

    consumed = match.index + match[0].length;
    if (regex.lastIndex < consumed) regex.lastIndex = consumed;
  }

  if (consumed > 0) {
    state.hexCarry = cleanHexSegment(state.hexCarry.slice(consumed));
    keepBottomIfNeeded();
  }

  trimHexCarryOverflow();
}

function finishHexCarry() {
  const rest = cleanHexSegment(state.hexCarry);
  state.hexCarry = "";

  if (rest) {
    addCompleteLine({ time: nowTime(), level: "", message: rest });
  }
}

function cleanHexSegment(value) {
  return value.trim().replace(/\s+/g, " ");
}

function trimHexCarryOverflow() {
  if (state.hexCarry.length <= MAX_HEX_CARRY_LENGTH) return;

  const target = state.hexCarry.length - HEX_CARRY_RETAIN_LENGTH;
  let cutoff = state.hexCarry.indexOf(" ", target);
  if (cutoff < 0) cutoff = target;

  state.hexCarry = cleanHexSegment(state.hexCarry.slice(cutoff));
  setStatus("HEX断行缓存过长，已丢弃未匹配数据");
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

  state.currentLineDirty = true;
  scheduleCurrentLineUpdate();

  if (state.carry.length >= MAX_LIVE_LINE_LENGTH) {
    finishAsciiLine({ force: true });
  }
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

  state.currentLineDirty = false;
  queueAutoSave([state.currentLine]);
  state.currentLine = null;
  state.carry = "";
  keepBottomIfNeeded();
}

function scheduleCurrentLineUpdate() {
  if (state.currentLineScheduled) return;

  state.currentLineScheduled = true;
  requestAnimationFrame(flushCurrentLineUpdate);
}

function flushCurrentLineUpdate() {
  state.currentLineScheduled = false;
  updateCurrentLineIfDirty();
}

function updateCurrentLineIfDirty() {
  if (!state.currentLine || !state.currentLineDirty) return;

  updateDisplayLine(state.currentLine, state.carry);
  state.currentLineDirty = false;
  updateLineElement(state.currentLine);
  keepBottomIfNeeded();
}

function addCompleteLine(item) {
  addLine(item, { save: true });
}

function addLine(item, options = {}) {
  const shouldFollow = shouldAutoFollow();

  item.dropped = false;
  state.lines.push(item);
  if (state.lines.length === 1) ui.lines.textContent = "";
  queueRenderLine(item, shouldFollow);

  if (options.save !== false) queueAutoSave([item]);

  while (state.lines.length > MAX_LINES) {
    const removed = state.lines.shift();
    if (removed) removed.dropped = true;
    removed?.el?.remove();
  }
}

function queueRenderLine(item, shouldFollow) {
  state.renderQueue.push(item);
  state.pendingFollow = state.pendingFollow || shouldFollow;

  if (!state.renderScheduled) {
    state.renderScheduled = true;
    requestAnimationFrame(flushRenderQueue);
  }
}

function flushRenderQueue() {
  state.renderScheduled = false;
  const fragment = document.createDocumentFragment();
  let rendered = 0;

  while (state.renderQueue.length && rendered < MAX_RENDER_BATCH) {
    const item = state.renderQueue.shift();
    if (!item || item.dropped) continue;

    if (item === state.currentLine) updateCurrentLineIfDirty();

    const el = createLineElement(item);
    item.el = el;
    fragment.appendChild(el);
    rendered += 1;
  }

  if (rendered) {
    ui.lines.appendChild(fragment);
    if (state.pendingFollow && shouldAutoFollow()) scrollToBottom();
  }

  if (state.renderQueue.length) {
    state.renderScheduled = true;
    requestAnimationFrame(flushRenderQueue);
    return;
  }

  state.pendingFollow = false;
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
  finishHexCarry();
  updateModeControls();
  setStatus(state.reading ? "已连接" : "未连接");
}

function updateModeControls() {
  const isHex = ui.displayMode.value === "hex";
  ui.frameRegexField.hidden = !isHex;
  ui.frameRegex.disabled = !isHex;
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

function compileFrameRegex() {
  state.framePattern = ui.frameRegex.value.trim();
  state.frameRegex = null;

  if (!state.framePattern) {
    ui.frameRegex.title = "";
    ui.frameRegex.classList.remove("invalid");
    return;
  }

  try {
    state.frameRegex = new RegExp(normalizeFramePattern(state.framePattern), "gi");
    ui.frameRegex.title = "";
    ui.frameRegex.classList.remove("invalid");
  } catch (error) {
    ui.frameRegex.title = error.message;
    ui.frameRegex.classList.add("invalid");
    setStatus("HEX断行正则无效");
  }
}

function normalizeFramePattern(pattern) {
  let value = pattern;
  if (value.startsWith("^")) value = value.slice(1);
  if (hasTrailingUnescapedDollar(value)) value = value.slice(0, -1);
  return value;
}

function hasTrailingUnescapedDollar(value) {
  if (!value.endsWith("$")) return false;

  let slashCount = 0;
  for (let i = value.length - 2; i >= 0 && value[i] === "\\"; i--) {
    slashCount += 1;
  }

  return slashCount % 2 === 0;
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
  const shouldFollow = shouldAutoFollow();
  const fragment = document.createDocumentFragment();
  state.renderQueue.length = 0;
  state.pendingFollow = false;

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
  finishHexCarry();

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
  for (const item of state.lines) item.dropped = true;
  state.lines.length = 0;
  state.renderQueue.length = 0;
  state.pendingFollow = false;
  state.carry = "";
  state.currentLine = null;
  state.currentLineDirty = false;
  state.pendingCR = false;
  state.hexCarry = "";
  state.stickToBottom = true;
  state.userScrollPaused = false;
  ui.terminal.scrollTop = 0;
  updateJumpButton();
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
  state.programmaticScroll = true;
  ui.terminal.scrollTop = ui.terminal.scrollHeight;
  requestAnimationFrame(() => {
    state.programmaticScroll = false;
    updateJumpButton();
  });
}

function keepBottomIfNeeded() {
  if (shouldAutoFollow()) scrollToBottom();
}

function shouldAutoFollow() {
  return state.stickToBottom && !state.userScrollPaused;
}

function pauseAutoFollow() {
  if (isNearBottom()) return;

  state.userScrollPaused = true;
  state.stickToBottom = false;
  state.pendingFollow = false;
  updateJumpButton();
}

function resumeAutoFollow(options = {}) {
  state.userScrollPaused = false;
  state.stickToBottom = true;
  state.pendingFollow = true;
  updateJumpButton();

  if (options.scroll) scrollToBottom();
}

function handleTerminalWheel(event) {
  if (event.deltaY < 0) pauseAutoFollow();
}

function handleTerminalKeydown(event) {
  if (event.key === "End") {
    resumeAutoFollow({ scroll: true });
    return;
  }

  if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
    pauseAutoFollow();
  }
}

function handleTerminalScroll() {
  if (isNearBottom()) {
    resumeAutoFollow({ scroll: false });
    return;
  }

  if (!state.programmaticScroll) {
    state.userScrollPaused = true;
    state.stickToBottom = false;
    state.pendingFollow = false;
  }

  updateJumpButton();
}

function isNearBottom() {
  const distance = ui.terminal.scrollHeight - ui.terminal.scrollTop - ui.terminal.clientHeight;
  return distance <= Math.max(LINE_HEIGHT * 4, 180);
}

function updateJumpButton() {
  ui.jumpToBottomBtn.hidden = !state.userScrollPaused;
}
