#!/usr/bin/env node
'use strict';

/**
 * 「他的手」这一包的 MCP 入口：nova_feed_read / nova_image_generate /
 * nova_zhihu_post / nova_sing。
 *
 * 用到的 env（全部可选，不给就是生产现在的值；密钥没给的那个工具调用时会明说「没配」）：
 *   GATE_TOOL_SOCKET              桥的工具口（必须给，2026-10-21 起没有默认）
 *   NOVA_IMAGE_API_KEY / OPENAI_API_KEY   出图的 key（密钥）
 *   NOVA_IMAGE_API_BASE_URL / OPENAI_BASE_URL / NOVA_IMAGE_MODEL /
 *   NOVA_IMAGE_OUTPUT_DIR / NOVA_IMAGE_TIMEOUT_MS / NOVA_STATE_DIR
 *   ELEVENLABS_API_KEY            唱歌（密钥）
 *   HANDS_SONG_CONFIG / HANDS_SONG_DIR / HANDS_FFMPEG
 *   HANDS_FEEDS_FILE
 *   HANDS_ZHIHU_PROFILE / HANDS_PLAYWRIGHT / DISPLAY
 * 细节见 lib/config.js。
 */

const { serve } = require('../_lib/mcp-stdio');
const { makeTools } = require('./tools');

serve({ name: 'hands', tools: makeTools() });
