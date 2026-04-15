// server.js - 使用讯飞星火 WebSocket TTS 接口（支持新音色）
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ---------- DeepSeek 配置 ----------
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-302d6b2d11064ec08a9124db9baafb8f';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

function buildDeepSeekPrompt(role) {
    const rolePrompts = {
        craftsman: '你是一位明代香山帮的匠人，正在向游客介绍晋祠的对越坊。请用第一人称、朴实而自豪的口吻，讲述建造这座牌坊的经历、斗拱榫卯的技艺，以及“对越”二字的含义。语气要生动、有历史感，约120字。',
        scholar: '你是一位明代文人，站在晋祠对越坊前。请用文雅、抒情的语言，介绍牌坊的建筑美感、匾额书法，以及你对“对越”二字的感悟。融入一些诗词意境，约120字。',
        architect: '你是一位梁思成先生的弟子，从建筑学角度分析晋祠对越坊。请用专业但不失亲切的语气，讲解牌坊的柱侧脚、生起、屋顶曲线等明代特征，以及其结构美学价值。约120字。'
    };
    return rolePrompts[role] || rolePrompts.craftsman;
}

async function generateNarrative(role) {
    const prompt = buildDeepSeekPrompt(role);
    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: '你是一位古建筑专家，语言富有感染力，回复简洁有力。' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 300
        }, {
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        console.error('DeepSeek 生成失败:', error.response?.data || error.message);
        const fallbacks = {
            craftsman: '万历四年，我随师傅建此牌坊。“对越”出自《诗经·周颂》，意在报答颂扬。你看这斗拱，层层出挑，不用一钉。四柱三间，中高旁低，如鸟斯革。',
            scholar: '对越坊立于晋祠中轴，明代建筑。其匾额“对越”为高应元所书，笔力遒劲。牌坊不仅为门，更含礼仪。我常于此吟咏，感怀晋水之源。',
            architect: '从测绘角度看，对越坊四柱比例精妙，柱侧脚、生起明显。屋顶曲线柔和，是明代官式与地方手法结合之作。我们正在用AI还原其彩绘原貌。'
        };
        return fallbacks[role] || fallbacks.craftsman;
    }
}

// ---------- 讯飞星火 WebSocket TTS 配置 ----------
const XF_APPID = process.env.XF_APPID || 'd4cf1bb9';
const XF_API_KEY = process.env.XF_API_KEY || '4b65fee103407decffb620e2c84332c5';
const XF_API_SECRET = process.env.XF_API_SECRET || 'ZTM0Y2YwYmFkZWQzM2U5OWNhZmI2Nzhh';
const XF_TTS_HOST = "tts-api.xfyun.cn";
const XF_TTS_PATH = "/v2/tts";

// 音色映射：前端选项 -> 讯飞实际 vcn 代码（包含基础音色和新增的聆系列音色）
const voiceMap = {
    // 基础音色（之前已授权）
    'xiaolu': 'x4_yezi',                // 小露 · 自然流畅女声
    'xiaoyan': 'x4_xiaoyan',            // 小燕 · 标准女声
    'xiaojiu': 'aisjiuxu',              // 许久 · 成熟稳重男声
    'xiaojing': 'aisjinger',            // 小婧 · 知性女声
    
    // 新增聆系列音色
    'lingxiaoshan': 'x4_lingxiaoshan_casualnews',   // 聆小珊 · 资讯女声
    'lingxiaoyun': 'x4_lingxiaoyun_talk_emo',       // 聆小芸 · 多情感女声
    'lingxiaoyao': 'x4_lingxiaoyao_comic',          // 聆小瑶 · 动漫女声
    'lingfeiyuan': 'x4_lingfeiyuan_gamecom',        // 聆飞远 · 游戏男声
    'lingbosong': 'x4_lingbosong',                  // 聆伯松 · 沉稳男声
    
    // 兼容旧选项（保留，方便角色默认使用）
    'male-qn-qingse': 'x4_yezi',        // 青涩古风男声 → 小露
    'male-qn-jingying': 'aisjiuxu',     // 清朗文人男声 → 许久
    'female-shaonv': 'x4_xiaoyan',      // 知性女声 → 小燕
    'auto': 'x4_yezi'                   // 默认使用小露
};

const roleDefaultVoice = {
    craftsman: 'male-qn-qingse',   // 匠人 → 青涩古风男声 → 实际映射到 x4_yezi
    scholar: 'male-qn-jingying',   // 文人 → 清朗文人男声 → 实际映射到 aisjiuxu
    architect: 'female-shaonv'     // 学者 → 知性女声 → 实际映射到 x4_xiaoyan
};

/**
 * 生成讯飞 WebSocket TTS 的连接URL
 */
function buildTtsWebSocketUrl(voiceId, role) {
    // 确定实际使用的音色 ID（前端传递的 voiceId 可能是 auto 或具体音色名）
    let actualVoiceId = voiceId;
    if (voiceId === 'auto') {
        const defaultVoiceKey = roleDefaultVoice[role] || 'male-qn-qingse';
        actualVoiceKey = defaultVoiceKey;
    }
    // 从映射表中获取讯飞 vcn 代码
    const vcn = voiceMap[actualVoiceId] || voiceMap['auto'];
    
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${XF_TTS_HOST}\ndate: ${date}\nGET ${XF_TTS_PATH} HTTP/1.1`;
    const signature = crypto.createHmac('sha256', XF_API_SECRET)
        .update(signatureOrigin)
        .digest('base64');
    const authorizationOrigin = `api_key="${XF_API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');
    const url = `wss://${XF_TTS_HOST}${XF_TTS_PATH}?authorization=${authorization}&date=${encodeURIComponent(date)}&host=${XF_TTS_HOST}`;
    
    console.log(`[TTS] 生成URL for voice ${actualVoiceId} (vcn: ${vcn})`);
    return { url, vcn };
}

/**
 * 通过 WebSocket 调用讯飞星火 TTS
 */
async function synthesizeSpeech(text, speed = 1.0, pitch = 0, voiceId = 'auto', role = 'craftsman') {
    const xfSpeed = Math.min(100, Math.max(0, Math.round((speed - 0.7) / 0.6 * 100)));
    const xfPitch = Math.min(100, Math.max(0, Math.round((pitch + 12) / 24 * 100)));
    
    const { url, vcn } = buildTtsWebSocketUrl(voiceId, role);
    
    return new Promise((resolve, reject) => {
        let audioBuffers = [];
        let isError = false;
        let timeoutId = null;

        timeoutId = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
            reject(new Error('WebSocket TTS 请求超时 (20秒)'));
        }, 20000);

        const ws = new WebSocket(url);
        
        ws.on('open', () => {
            console.log('[TTS] WebSocket 连接已打开，发送合成请求');
            const requestData = {
                common: { app_id: XF_APPID },
                business: {
                    aue: "lame",
                    sfl: 1,
                    auf: "audio/L16;rate=16000",
                    vcn: vcn,
                    tte: "UTF8",
                    speed: xfSpeed,
                    pitch: xfPitch,
                    volume: 80
                },
                data: {
                    text: Buffer.from(text).toString('base64'),
                    status: 2
                }
            };
            ws.send(JSON.stringify(requestData));
        });
        
        ws.on('message', (data) => {
            try {
                let response;
                if (Buffer.isBuffer(data)) {
                    response = JSON.parse(data.toString('utf8'));
                } else {
                    response = JSON.parse(data);
                }
                
                if (response.code !== 0) {
                    console.error('[TTS] 业务错误:', response);
                    isError = true;
                    reject(new Error(`讯飞TTS业务错误: ${response.code} - ${response.message}`));
                    if (ws.readyState === WebSocket.OPEN) ws.close();
                    if (timeoutId) clearTimeout(timeoutId);
                    return;
                }
                
                if (response.data && response.data.audio) {
                    const audioBuffer = Buffer.from(response.data.audio, 'base64');
                    audioBuffers.push(audioBuffer);
                }
                
                if (response.data && response.data.status === 2) {
                    console.log('[TTS] 合成完成，共收到', audioBuffers.length, '个音频片段');
                    const fullAudioBuffer = Buffer.concat(audioBuffers);
                    const fullAudioBase64 = fullAudioBuffer.toString('base64');
                    resolve(fullAudioBase64);
                    if (ws.readyState === WebSocket.OPEN) ws.close();
                    if (timeoutId) clearTimeout(timeoutId);
                }
            } catch (err) {
                console.error('[TTS] 解析响应失败:', err);
                isError = true;
                reject(new Error(`解析响应失败: ${err.message}`));
                if (ws.readyState === WebSocket.OPEN) ws.close();
                if (timeoutId) clearTimeout(timeoutId);
            }
        });
        
        ws.on('error', (err) => {
            console.error('[TTS] WebSocket 连接错误:', err);
            if (!isError) reject(new Error(`WebSocket 连接失败: ${err.message}`));
            if (timeoutId) clearTimeout(timeoutId);
        });
        
        ws.on('close', (code, reason) => {
            console.log('[TTS] WebSocket 连接关闭:', code, reason?.toString());
            if (!isError && audioBuffers.length === 0) reject(new Error(`WebSocket 意外关闭: ${code}`));
            if (timeoutId) clearTimeout(timeoutId);
        });
    });
}

// ---------- API 路由 ----------
app.post('/api/generate', async (req, res) => {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: '缺少 role 参数' });
    try {
        const narrative = await generateNarrative(role);
        res.json({ success: true, narrative });
    } catch (error) {
        console.error('生成文本失败:', error);
        res.status(500).json({ error: '生成叙事失败' });
    }
});

app.post('/api/tts', async (req, res) => {
    const { text, speed, pitch, voiceId, role } = req.body;
    if (!text) return res.status(400).json({ error: '缺少文本' });
    try {
        const audioBase64 = await synthesizeSpeech(text, speed, pitch, voiceId, role);
        res.json({ success: true, audio: audioBase64 });
    } catch (error) {
        console.error('TTS失败:', error);
        res.status(500).json({ error: `语音合成失败: ${error.message}` });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 服务已启动: http://localhost:${PORT}`);
    console.log(`📝 DeepSeek + 讯飞星火 WebSocket TTS 已就绪`);
});