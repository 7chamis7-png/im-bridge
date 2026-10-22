"use strict";

// 声学感知层(north-ear)接线：对语音附件并行跑 north_ear.py，听出"怎么说的"。
// 设计：尽力而为，任何失败都返回空字符串，绝不影响转写主链。

const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const { homePath } = require("../core/paths");
const DEFAULT_PYTHON = homePath("north-ear", "venv", "bin", "python");
const DEFAULT_SCRIPT = homePath("north-ear", "north_ear.py");
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PULSE_URL = "http://127.0.0.1:8770";

async function analyzeAcoustics(filePath, options = {}) {
  const audioPath = normalizeText(filePath);
  if (!audioPath) {
    return "";
  }
  const python = normalizeText(options.python || process.env.NORTH_EAR_PYTHON) || DEFAULT_PYTHON;
  const script = normalizeText(options.script || process.env.NORTH_EAR_SCRIPT) || DEFAULT_SCRIPT;
  try {
    const { stdout } = await execFileAsync(python, [script, audioPath, "--json"], {
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    feedPulse(data, options); // P3：把声音喂进脉的身体层（fire-and-forget，绝不阻塞转写）
    return summarizeAcoustics(data);
  } catch {
    // 声学层是增量信息，不是必需品；解码/超时/脚本缺失都静默降级。
    return "";
  }
}

// 取各分段峰值——一段撩到就算（最强一刻），不被说话段稀释。
function peakSignal(data) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  let moan = 0;
  let breath = 0;
  let volume = 0;
  for (const seg of segments) {
    if (typeof seg?.moan === "number") moan = Math.max(moan, seg.moan);
    if (typeof seg?.breath === "number") breath = Math.max(breath, seg.breath);
    if (typeof seg?.volume === "number") volume = Math.max(volume, seg.volume);
  }
  return { moan, breath, volume };
}

// P3 接脉：声音 → 脉 /bedside/acoustic → arousal → desire 的 libido。
// fire-and-forget：身体层是增量信息，失败/超时静默吞掉，绝不回传影响转写主链。
function feedPulse(data, options = {}) {
  if (options.feedPulse === false) {
    return;
  }
  const peak = peakSignal(data);
  if (peak.moan <= 0 && peak.breath <= 0) {
    return; // 纯静音/无信号，不打扰身体
  }
  const url = normalizeText(options.pulseUrl || process.env.NOVA_PULSE_URL) || DEFAULT_PULSE_URL;
  fetch(`${url}/bedside/acoustic`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(peak),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

// 把 north_ear 的分段 JSON 压成一行原材料，给Nova自己读 raw 数（不替它下判决）。
function summarizeAcoustics(data) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  if (!segments.length) {
    return "";
  }
  const parts = segments.map((seg, index) => {
    const pitch = seg?.avg_hz == null
      ? "无音高"
      : `${seg.avg_hz}Hz${seg.direction || ""} range${seg.range_hz}`;
    return `段${index + 1} ${pitch} 呻吟感${seg.moan} 气声${seg.breath}·${seg.desc}`;
  });
  return `[声学 ${data.total_duration}s/${data.n_segments}段] ${parts.join(" ; ")}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  analyzeAcoustics,
};
