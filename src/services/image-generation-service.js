const fs = require("fs");
const path = require("path");

const REPLICATE_API_BASE = "https://api.replicate.com/v1";
const REPLICATE_POLL_INTERVAL_MS = 1_000;

class ImageGenerationService {
  constructor({ config }) {
    this.config = config;
  }

  async generate(args = {}) {
    const prompt = normalizeText(args.prompt);
    if (!prompt) {
      throw new Error("Missing image prompt.");
    }
    const apiKey = normalizeText(this.config.imageApiKey);
    if (!apiKey) {
      throw new Error("Missing image API key. Set NOVA_IMAGE_API_KEY or OPENAI_API_KEY.");
    }
    const n = clampInteger(args.n, 1, 4, 1);
    const timeoutMs = Number.isFinite(this.config.imageTimeoutMs) ? this.config.imageTimeoutMs : 120_000;

    if (isReplicateApiKey(apiKey)) {
      return this._generateReplicate({ args, prompt, apiKey, n, timeoutMs });
    }
    return this._generateOpenAI({ args, prompt, apiKey, n, timeoutMs });
  }

  async _generateOpenAI({ args, prompt, apiKey, n, timeoutMs }) {
    const model = normalizeText(args.model) || normalizeText(this.config.imageModel) || "gpt-image-2";
    const size = normalizeText(args.size) || "1024x1024";
    const quality = normalizeText(args.quality);
    const background = normalizeText(args.background);

    const payload = { model, prompt, n, size };
    if (quality) payload.quality = quality;
    if (background) payload.background = background;

    const json = await fetchJson(`${normalizeBaseUrl(this.config.imageApiBaseUrl)}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs,
      errorPrefix: "Image API",
    });

    const items = Array.isArray(json.data) ? json.data : [];
    if (!items.length) {
      throw new Error("Image API returned no images.");
    }

    const { outputDir, createdAt } = this._prepareOutputDir();
    const files = [];
    items.forEach((item, index) => {
      const base64 = normalizeText(item.b64_json);
      if (!base64) return;
      const filePath = path.join(outputDir, `${createdAt}-${index + 1}.png`);
      fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
      files.push({ filePath, bytes: fs.statSync(filePath).size });
    });

    if (!files.length) {
      throw new Error("Image API response did not include b64_json images.");
    }
    return { files, model, size, prompt };
  }

  async _generateReplicate({ args, prompt, apiKey, n, timeoutMs }) {
    const model = normalizeText(args.model) || normalizeText(this.config.imageModel) || "black-forest-labs/flux-schnell";
    const [owner, modelName] = splitReplicateModel(model);
    const size = normalizeText(args.size);

    const input = { prompt, num_outputs: n };
    const aspectRatio = sizeToAspectRatio(size);
    if (aspectRatio) input.aspect_ratio = aspectRatio;

    const headers = {
      authorization: `Token ${apiKey}`,
      "content-type": "application/json",
    };

    const created = await fetchJson(`${REPLICATE_API_BASE}/models/${owner}/${modelName}/predictions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
      timeoutMs,
      errorPrefix: "Replicate API",
    });

    const getUrl = created?.urls?.get;
    if (!getUrl) {
      throw new Error("Replicate API response did not include a poll URL.");
    }

    const prediction = await this._pollReplicatePrediction(getUrl, headers, timeoutMs);
    const outputs = Array.isArray(prediction.output)
      ? prediction.output
      : prediction.output
        ? [prediction.output]
        : [];
    if (!outputs.length) {
      throw new Error("Replicate prediction succeeded but returned no output images.");
    }

    const { outputDir, createdAt } = this._prepareOutputDir();
    const files = [];
    for (let index = 0; index < outputs.length; index += 1) {
      const url = normalizeText(outputs[index]);
      if (!url) continue;
      const buffer = await downloadBuffer(url, timeoutMs);
      const filePath = path.join(outputDir, `${createdAt}-${index + 1}.png`);
      fs.writeFileSync(filePath, buffer);
      files.push({ filePath, bytes: buffer.length });
    }

    if (!files.length) {
      throw new Error("Replicate prediction output did not include any downloadable images.");
    }
    return { files, model, size, prompt };
  }

  async _pollReplicatePrediction(getUrl, headers, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const prediction = await fetchJson(getUrl, {
        method: "GET",
        headers,
        timeoutMs,
        errorPrefix: "Replicate API",
      });
      const status = prediction.status;
      if (status === "succeeded") {
        return prediction;
      }
      if (status === "failed" || status === "canceled") {
        const message = prediction.error || `Replicate prediction ${status}.`;
        throw new Error(`Replicate prediction ${status}: ${message}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Replicate prediction timed out after ${timeoutMs}ms (last status: ${status}).`);
      }
      await sleep(Math.min(REPLICATE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  _prepareOutputDir() {
    fs.mkdirSync(this.config.imageOutputDir, { recursive: true });
    return {
      outputDir: this.config.imageOutputDir,
      createdAt: new Date().toISOString().replace(/[:.]/g, "-"),
    };
  }
}

async function fetchJson(url, { method, headers, body, timeoutMs, errorPrefix }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let json = {};
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = {};
  }
  if (!response.ok) {
    const message = json?.error?.message || json?.detail || raw.slice(0, 500) || response.statusText;
    throw new Error(`${errorPrefix} failed (${response.status}): ${message}`);
  }
  return json;
}

async function downloadBuffer(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to download image (${response.status}): ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReplicateApiKey(apiKey) {
  return apiKey.startsWith("r8_");
}

function splitReplicateModel(model) {
  const [owner, ...rest] = model.split("/");
  const modelName = rest.join("/");
  if (!owner || !modelName) {
    throw new Error(`Invalid Replicate model "${model}". Expected format "owner/model".`);
  }
  return [owner, modelName];
}

function sizeToAspectRatio(size) {
  const match = /^(\d+)x(\d+)$/.exec(normalizeText(size));
  if (!match) return "";
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (!width || !height) return "";
  const gcdValue = gcd(width, height);
  return `${width / gcdValue}:${height / gcdValue}`;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value) {
  return (normalizeText(value) || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function clampInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = { ImageGenerationService };
