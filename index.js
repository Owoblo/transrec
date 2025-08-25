import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const { OPENAI_API_KEY, ELEVEN_API_KEY, ELEVEN_VOICE_ID, ELEVEN_MODEL_ID } = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file.');
  process.exit(1);
}
if (!ELEVEN_API_KEY) {
  console.error('Missing ElevenLabs API key. Please set it in the .env file.');
  process.exit(1);
}
if (!ELEVEN_VOICE_ID) {
  console.error('Missing ElevenLabs Voice ID. Please set it in the .env file.');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// --------- Config you’ll actually tune ----------
const SYSTEM_MESSAGE =
  `You are Sam, our virtual sales rep. Speak in short, natural sentences. Ask one question, then stop and listen. If the caller interrupts, stop speaking immediately.`;
const PORT = process.env.PORT || 5050;
const ELEVEN_STREAM_URL = (voiceId) =>
  `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input`;

// VAD / pacing (server-controlled)
const FRAME_BYTES = 160;           // μ-law @8kHz → 20ms frames
const MIN_FRAMES_TO_COMMIT = 6;    // ≥120ms buffered before commit
const SILENCE_MS = 400;            // 400ms of silence → commit

// -------------------- Util: μ-law framing --------------------
function sliceIntoUlaw20msFrames(ulawBuffer, carry = Buffer.alloc(0)) {
  const buf = Buffer.concat([carry, ulawBuffer]);
  const frames = [];
  let off = 0;
  while (off + FRAME_BYTES <= buf.length) {
    frames.push(buf.subarray(off, off + FRAME_BYTES));
    off += FRAME_BYTES;
  }
  return { frames, leftover: buf.subarray(off) };
}

// Root — quick health check
fastify.get('/', async (_req, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Twilio webhook → return TwiML that opens a bidirectional media stream
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers.host; // you can hardcode your Render host if you prefer
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
  reply.type('text/xml').send(twimlResponse);
});

// Media stream bridge
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    // ----- OpenAI Realtime (TEXT OUT only) -----
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    // State
    let streamSid = null;
    let openaiReady = false;

    // ElevenLabs streaming TTS
    let elevenWs = null;
    let ttsPlaying = false;
    let ttsCarry = Buffer.alloc(0);

    // Inbound audio buffer (for commits)
    let bytesBuffered = 0;
    let collecting = false;
    let silenceTimer = null;

    const setAudioBuffer = (newVal) => { bytesBuffered = newVal; };

    function stopTTS() {
      ttsPlaying = false;
      ttsCarry = Buffer.alloc(0);
      try { if (elevenWs && elevenWs.readyState === WebSocket.OPEN) elevenWs.close(); } catch {}
      elevenWs = null;
    }

    // Speak via ElevenLabs (μ-law 8kHz streaming → Twilio)
    function speakWithEleven(text, attempt = 0) {
      if (!text || !text.trim()) return;

      // Don’t speak before Twilio stream is ready
      if (!streamSid || connection.socket.readyState !== WebSocket.OPEN) {
        if (attempt < 20) { // retry for up to ~2s
          return setTimeout(() => speakWithEleven(text, attempt + 1), 100);
        }
        console.warn('No streamSid or Twilio WS not open; skipping TTS.');
        return;
      }

      // Prevent overlap; barge-in will call stopTTS()
      if (ttsPlaying) return;

      // fresh TTS connection per utterance
      if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
        try { elevenWs.close(); } catch {}
      }
      elevenWs = new WebSocket(ELEVEN_STREAM_URL(ELEVEN_VOICE_ID), {
        headers: { 'xi-api-key': ELEVEN_API_KEY }
      });
      ttsPlaying = true;
      ttsCarry = Buffer.alloc(0);

      const onOpen = () => {
        const payload = {
          text,
          model_id: ELEVEN_MODEL_ID || 'eleven_turbo_v2',
          output_format: 'ulaw_8000',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true
          },
          // Add later if you want to shave latency:
          // optimize_streaming_latency: 3
        };
        try { elevenWs.send(JSON.stringify(payload)); }
        catch (e) { console.error('EL send failed', e); stopTTS(); }
      };

      const onMessage = (chunk) => {
        // JSON control vs binary audio
        if (typeof chunk === 'string') {
          try {
            const msg = JSON.parse(chunk);
            if (msg.type === 'error') {
              console.error('ElevenLabs error:', msg);
              stopTTS();
              return;
            }
            if (msg.type === 'audio_stream_end') {
              stopTTS();
              return;
            }
            // ignore other JSON controls
            return;
          } catch {
            // fallthrough if EL sometimes sends non-JSON text
          }
        }

        // Binary μ-law audio; frame at 20ms (160 bytes)
        const buf = Buffer.from(chunk);
        const { frames, leftover } = sliceIntoUlaw20msFrames(buf, ttsCarry);
        ttsCarry = leftover;

        for (const frame of frames) {
          if (!ttsPlaying || connection.socket.readyState !== WebSocket.OPEN || !streamSid) break;
          try {
            connection.socket.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: frame.toString('base64') }
            }));
          } catch (e) {
            console.error('Failed to send frame to Twilio:', e);
            stopTTS();
            break;
          }
        }
      };

      const onClose = () => stopTTS();
      const onError = (e) => { console.error('ElevenLabs WS error:', e.message); stopTTS(); };

      elevenWs.on('open', onOpen);
      elevenWs.on('message', onMessage);
      elevenWs.on('close', onClose);
      elevenWs.on('error', onError);
    }

    // Commit current audio & ASK the model to respond (manual turns)
    function commitAudioBuffer() {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      const frames = Math.floor(bytesBuffered / FRAME_BYTES);
      if (frames < MIN_FRAMES_TO_COMMIT) return;
      if (openAiWs.readyState !== WebSocket.OPEN || !openaiReady) return;

      try {
        // 1) finalize input
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        // 2) explicitly request a reply
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
        // Do NOT reset buffer here; wait for input_audio_buffer.committed
      } catch (e) {
        console.error('commit/response.create failed:', e);
      }
    }

    // ---------- OpenAI session ----------
    const sendSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          model: 'gpt-4o-realtime-preview-2024-10-01',
          modalities: ['text'],             // we only want text out
          input_audio_format: 'g711_ulaw',  // Twilio sends μ-law
          turn_detection: {
            type: 'server_vad',
            threshold: 0.55,
            prefix_padding_ms: 200,
            silence_duration_ms: SILENCE_MS,
            create_response: false,         // we control turns; we send response.create
            interrupt_response: true
          },
          max_response_output_tokens: 120,
          instructions: SYSTEM_MESSAGE
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on('open', () => {
      console.log('Connected to OpenAI Realtime');
      setTimeout(sendSessionUpdate, 250);
    });

    // Welcome once BOTH OpenAI is ready and Twilio streamSid exists
    const tryWelcome = (attempt = 0) => {
      if (openaiReady && streamSid && connection.socket.readyState === WebSocket.OPEN) {
        speakWithEleven("Hi, Saturn Star Movers—this is our virtual sales rep. How can I help today?");
      } else if (attempt < 40) {
        setTimeout(() => tryWelcome(attempt + 1), 100);
      }
    };

    // OpenAI events
    let textBuffer = '';
    openAiWs.on('message', (raw) => {
      let evt;
      try { evt = JSON.parse(raw); } catch { return; }

      // Debug essential events
      if (evt.type === 'error' || evt.error) {
        console.error('OpenAI error:', evt.error || evt);
      }

      if (evt.type === 'session.updated') {
        openaiReady = true;
        tryWelcome(); // will wait for streamSid if needed
      }

      // Streamed deltas (optional to use)
      if (evt.type === 'response.output_text.delta' && evt.delta) {
        textBuffer += evt.delta;
      }

      // Audio buffer lifecycle
      if (evt.type === 'input_audio_buffer.committed') {
        // Now safe to reset our local buffer for next turn
        setAudioBuffer(0);
        collecting = false;
      }

      // Final/Done → extract full text and speak
      if (evt.type === 'response.completed' || evt.type === 'response.done') {
        // Prefer structured output if present
        const fullText = (evt.response?.output || [])
          .filter(p => p.type === 'output_text')
          .map(p => p.text)
          .join(' ')
          .trim();

        const toSpeak = fullText || textBuffer.trim();
        textBuffer = '';

        if (toSpeak) speakWithEleven(toSpeak);
      }
    });

    openAiWs.on('close', (c, r) => {
      console.log('OpenAI WS closed', c, r?.toString());
    });
    openAiWs.on('error', (e) => {
      console.error('OpenAI WS error:', e.message);
    });

    // ---------- Twilio media ----------
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream started', streamSid);
            // If OpenAI is already ready, try welcome now
            tryWelcome();
            break;

          case 'media': {
            // barge-in: stop TTS if caller talks
            if (ttsPlaying) stopTTS();

            if (openAiWs.readyState === WebSocket.OPEN && openaiReady) {
              // forward audio chunk to OpenAI
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              }));

              // Track bytes for commit threshold
              const rawLen = Buffer.from(data.media.payload, 'base64').length;
              if (!collecting) collecting = true;
              setAudioBuffer(bytesBuffered + rawLen);

              // silence timer: when no new audio arrives for N ms → commit & request response
              if (silenceTimer) clearTimeout(silenceTimer);
              silenceTimer = setTimeout(() => commitAudioBuffer(), SILENCE_MS);
            }
            break;
          }

          case 'stop':
            console.log('Stream stopped');
            break;

          default:
            // 'connected', etc.
            break;
        }
      } catch (e) {
        console.error('Error parsing Twilio msg:', e);
      }
    });

    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      stopTTS();
      console.log('Client disconnected.');
    });

    connection.on('error', (e) => {
      console.error('Twilio WS error:', e.message);
    });
  });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Server is listening on 0.0.0.0:${PORT}`);
});