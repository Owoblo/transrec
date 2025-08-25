import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();
// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY, ELEVEN_API_KEY, ELEVEN_VOICE_ID } = process.env;
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
// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
// Constants
const SYSTEM_MESSAGE = `You are Sam, our virtual sales rep. Speak in short, natural sentences. Ask one question, then stop and listen. If the caller interrupts, stop speaking immediately.`;
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// ElevenLabs configuration
const ELEVEN_STREAM_URL = (voiceId) =>
  `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

// VAD / pacing
const MIN_FRAMES_TO_COMMIT = 6;        // 6 * 20ms = 120ms min audio
const SILENCE_MS = 400;                // 400ms silence -> commit turn

// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
    'response.content.delta',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'error',
    'session.error',
    'input_audio_buffer.error',
    'response.error'
];

// -------------------- Util: μ-law framing --------------------
// Twilio expects base64 ulaw payloads in 20ms frames: 160 bytes each (8000 Hz * 0.02s)
function sliceIntoUlaw20msFrames(ulawBuffer, carry = Buffer.alloc(0)) {
  const buf = Buffer.concat([carry, ulawBuffer]);
  const FRAME_SIZE = 160; // bytes
  const frames = [];
  let offset = 0;
  while (offset + FRAME_SIZE <= buf.length) {
    frames.push(buf.subarray(offset, offset + FRAME_SIZE));
    offset += FRAME_SIZE;
  }
  const leftover = buf.subarray(offset);
  return { frames, leftover };
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});
// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;
    reply.type('text/xml').send(twimlResponse);
});
// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');
                const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });
        let streamSid = null;
        let openaiReady = false; // New flag to track when OpenAI is ready
        
        // ElevenLabs TTS state
        let elevenWs = null;
        let ttsPlaying = false;
        let ttsCarry = Buffer.alloc(0);
        
        // Audio buffer tracking - clean byte-based approach
        let bytesBuffered = 0;
        const FRAME_BYTES = 160;        // μ-law 8kHz, 20 ms = 160 bytes (before base64)
        const MIN_FRAMES = 6;           // 6 x 20 ms = 120 ms (latency tuned)
        let collecting = false;
        let silenceTimer = null;        // Timer for silence-based commit
        
        // Helper: commit audio buffer if we have enough data
        function commitAudioBuffer() {
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            
            console.log('=== COMMIT AUDIO BUFFER CALLED ===');
            console.log('Current buffer state - bytesBuffered:', bytesBuffered);
            console.log('Current buffer state - collecting:', collecting);
            console.log('OpenAI WebSocket state:', openAiWs.readyState);
            
            // Safety check: don't commit if we have no audio
            if (bytesBuffered === 0) {
                console.log('=== SKIPPING COMMIT ===');
                console.log('No audio buffered, skipping commit');
                return;
            }
            
            const frames = Math.floor(bytesBuffered / FRAME_BYTES);
            console.log('=== BUFFER ANALYSIS ===');
            console.log('Raw bytes buffered:', bytesBuffered);
            console.log('Frame size in bytes:', FRAME_BYTES);
            console.log('Calculated frames:', frames);
            console.log('Minimum frames required:', MIN_FRAMES);
            console.log('Frames >= MIN_FRAMES:', frames >= MIN_FRAMES);
            
            if (frames >= MIN_FRAMES && openAiWs.readyState === WebSocket.OPEN) {
                console.log('=== COMMITTING AUDIO BUFFER ===');
                console.log('Frames collected:', frames);
                console.log('Bytes buffered:', bytesBuffered);
                console.log('Buffer size in ms:', (bytesBuffered / FRAME_BYTES) * 20);
                
                try {
                    // Store buffer info before sending
                    const bufferInfo = {
                        bytes: bytesBuffered,
                        frames: frames,
                        timestamp: Date.now()
                    };
                    console.log('=== BUFFER INFO STORED ===');
                    console.log('Buffer info:', bufferInfo);
                    
                    // Commit the audio buffer
                    openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                    console.log('=== COMMIT MESSAGE SENT ===');
                    console.log('Commit sent at timestamp:', bufferInfo.timestamp);
                    console.log('Buffer state after sending commit:', bytesBuffered);
                    
                    // OpenAI will automatically generate a response
                    console.log('Waiting for OpenAI to generate response...');
                    
                    // Don't reset buffer yet - wait for OpenAI to confirm commit
                    // Buffer will be reset when we receive input_audio_buffer.committed event
                } catch (error) {
                    console.error('=== ERROR COMMITTING AUDIO ===');
                    console.error('Error details:', error);
                    // Only reset on error
                    console.log('=== RESETTING BUFFER DUE TO ERROR ===');
                    console.log('Previous bytesBuffered:', bytesBuffered);
                    bytesBuffered = 0;
                    collecting = false;
                    console.log('Buffer reset complete - bytesBuffered:', bytesBuffered);
                }
            } else {
                console.log('=== SKIPPING COMMIT ===');
                console.log('Too little audio - frames:', frames, '(<', MIN_FRAMES, ')');
                console.log('Bytes buffered:', bytesBuffered);
                console.log('WebSocket ready state:', openAiWs.readyState);
            }
        }
        
        // Helper: stop TTS immediately (barge-in)
        function stopTTS() {
            console.log('=== STOPPING TTS (BARGE-IN) ===');
            console.log('Current TTS state - ttsPlaying:', ttsPlaying);
            console.log('ElevenLabs WebSocket state:', elevenWs ? elevenWs.readyState : 'null');
            
            ttsPlaying = false;
            ttsCarry = Buffer.alloc(0);
            
            try { 
                if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
                    console.log('Closing ElevenLabs WebSocket connection');
                    elevenWs.close();
                }
            } catch (error) {
                console.error('Error closing ElevenLabs WebSocket:', error);
            }
            
            elevenWs = null;
            console.log('=== TTS STOPPED SUCCESSFULLY ===');
        }
        
        // Helper: speak via ElevenLabs (streaming)
        function speakWithEleven(text) {
            console.log('=== ELEVENLABS TTS REQUESTED ===');
            console.log('Text to speak:', text);
            console.log('Current TTS state - ttsPlaying:', ttsPlaying);
            console.log('Function called at timestamp:', Date.now());
            console.log('Call stack:', new Error().stack);
            
            if (!text || ttsPlaying) {
                console.log('=== TTS REQUEST REJECTED ===');
                console.log('Reason:', !text ? 'No text provided' : 'TTS already playing');
                return;
            }
            
            // Close any existing TTS connection
            if (elevenWs) {
                console.log('=== CLOSING EXISTING TTS CONNECTION ===');
                try { 
                    if (elevenWs.readyState === WebSocket.OPEN) {
                        elevenWs.close();
                    }
                } catch {}
                elevenWs = null;
            }
            
            // Open a new streaming TTS for this utterance
            console.log('=== OPENING ELEVENLABS WEBSOCKET ===');
            console.log('Voice ID:', ELEVEN_VOICE_ID);
            console.log('Stream URL:', ELEVEN_STREAM_URL(ELEVEN_VOICE_ID));
            console.log('API Key (first 10 chars):', ELEVEN_API_KEY.substring(0, 10) + '...');
            
            const elWs = new WebSocket(ELEVEN_STREAM_URL(ELEVEN_VOICE_ID), {
                headers: { 'xi-api-key': ELEVEN_API_KEY }
            });
            elevenWs = elWs;
            ttsPlaying = true;
            ttsCarry = Buffer.alloc(0);
            
            console.log('=== ELEVENLABS WEBSOCKET CREATED ===');
            console.log('WebSocket object created:', !!elWs);
            console.log('Initial WebSocket state:', elWs.readyState);
            console.log('TTS playing set to:', ttsPlaying);

            // Connection timeout
            const connectionTimeout = setTimeout(() => {
                if (elWs.readyState === WebSocket.CONNECTING) {
                    console.error('=== ELEVENLABS CONNECTION TIMEOUT ===');
                    console.error('Connection took longer than 10 seconds');
                    console.error('WebSocket state at timeout:', elWs.readyState);
                    elWs.close();
                }
            }, 10000); // 10 second timeout

            // Add connection state logging
            console.log('=== ELEVENLABS CONNECTION STATE TRACKING ===');
            console.log('Initial WebSocket state:', elWs.readyState);
            console.log('WebSocket URL:', ELEVEN_STREAM_URL(ELEVEN_VOICE_ID));
            console.log('API Key length:', ELEVEN_API_KEY.length);

            elWs.on('open', () => {
                clearTimeout(connectionTimeout);
                console.log('=== ELEVENLABS WEBSOCKET OPENED ===');
                console.log('Connection established successfully');
                console.log('WebSocket ready state:', elWs.readyState);
                console.log('Sending TTS request for text:', text.substring(0, 50) + '...');
                
                // Ask for ulaw_8000 so we can feed Twilio directly (no ffmpeg)
                const payload = {
                    text,
                    voice_settings: { 
                        stability: 0.5, 
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true
                    },
                    // Lower numbers may shave latency; experiment (0..3)
                    optimize_streaming_latency: 3,
                    // Critical: ulaw at 8kHz so we can send to Twilio directly
                    output_format: 'ulaw_8000',
                    // Enable chunking for better streaming
                    enable_timestamps: false,
                    chunk_length_scheduling_ms: 200
                };
                
                console.log('=== SENDING TTS PAYLOAD ===');
                console.log('Payload:', JSON.stringify(payload, null, 2));
                
                try {
                    elWs.send(JSON.stringify(payload));
                    console.log('=== TTS PAYLOAD SENT SUCCESSFULLY ===');
                    console.log('WebSocket state after sending:', elWs.readyState);
                } catch (error) {
                    console.error('=== FAILED TO SEND TTS PAYLOAD ===');
                    console.error('Error details:', error);
                    console.error('WebSocket state:', elWs.readyState);
                    stopTTS();
                }
            });

            elWs.on('message', (chunk) => {
                console.log('=== ELEVENLABS MESSAGE RECEIVED ===');
                console.log('Chunk type:', typeof chunk);
                console.log('Chunk size:', chunk.length || 'N/A');
                
                // ElevenLabs streams audio frames or chunks (binary or JSON keep-alives)
                if (typeof chunk === 'string') {
                    console.log('=== PROCESSING TEXT MESSAGE ===');
                    try {
                        const jsonMsg = JSON.parse(chunk);
                        console.log('=== ELEVENLABS JSON RESPONSE ===');
                        console.log('Message type:', jsonMsg.type);
                        console.log('Full message:', JSON.stringify(jsonMsg, null, 2));
                        
                        // Handle control messages
                        if (jsonMsg.type === 'error') {
                            console.error('=== ELEVENLABS ERROR MESSAGE ===');
                            console.error('Error details:', jsonMsg);
                            stopTTS();
                            return;
                        }
                        if (jsonMsg.type === 'audio_stream_start') {
                            console.log('=== ELEVENLABS AUDIO STREAM STARTED ===');
                            console.log('Audio streaming has begun');
                            return;
                        }
                        if (jsonMsg.type === 'audio_stream_end') {
                            console.log('=== ELEVENLABS AUDIO STREAM ENDED ===');
                            console.log('Audio streaming completed');
                            stopTTS();
                            return;
                        }
                        // Log any other JSON messages we might receive
                        console.log('=== UNKNOWN JSON MESSAGE TYPE ===');
                        console.log('Type:', jsonMsg.type);
                        console.log('Content:', jsonMsg);
                        return;
                    } catch (parseError) {
                        console.log('=== NON-JSON TEXT MESSAGE ===');
                        console.log('Failed to parse as JSON, treating as audio data');
                        console.log('Text content:', chunk.substring(0, 100) + '...');
                    }
                }
                
                // Chunk should be raw μ-law bytes (since we requested ulaw_8000)
                console.log('=== PROCESSING AUDIO CHUNK ===');
                console.log('Chunk buffer length:', chunk.length);
                
                const buf = Buffer.from(chunk);
                const { frames, leftover } = sliceIntoUlaw20msFrames(buf, ttsCarry);
                ttsCarry = leftover;
                
                console.log('=== AUDIO FRAME SLICING ===');
                console.log('Frames created:', frames.length);
                console.log('Leftover bytes:', leftover.length);
                console.log('Carry buffer size:', ttsCarry.length);

                frames.forEach((frame, index) => {
                    if (!ttsPlaying || connection.socket.readyState !== WebSocket.OPEN) {
                        console.log(`=== SKIPPING FRAME ${index} ===`);
                        console.log('Reason:', !ttsPlaying ? 'TTS stopped' : 'Twilio connection closed');
                        return;
                    }
                    
                    try {
                        const payloadB64 = frame.toString('base64');
                        console.log(`=== SENDING FRAME ${index} TO TWILIO ===`);
                        console.log('Frame size:', frame.length, 'bytes');
                        console.log('Base64 length:', payloadB64.length);
                        
                        connection.socket.send(JSON.stringify({
                            event: 'media',
                            streamSid,
                            media: { payload: payloadB64 }
                        }));
                        
                        console.log(`=== FRAME ${index} SENT SUCCESSFULLY ===`);
                    } catch (error) {
                        console.error(`=== FAILED TO SEND FRAME ${index} ===`);
                        console.error('Error details:', error);
                        stopTTS();
                    }
                });
            });

            const endTTS = () => { 
                console.log('=== ENDING TTS SESSION ===');
                ttsPlaying = false; 
                if (elevenWs) {
                    try { 
                        if (elevenWs.readyState === WebSocket.OPEN) {
                            elevenWs.close();
                        }
                    } catch {}
                    elevenWs = null;
                }
                console.log('=== TTS SESSION ENDED ===');
            };
            
            elWs.on('close', (code, reason) => {
                clearTimeout(connectionTimeout);
                console.log('=== ELEVENLABS WEBSOCKET CLOSED ===');
                console.log('Close code:', code);
                console.log('Close reason:', reason);
                console.log('WebSocket state:', elWs.readyState);
                endTTS();
            });
            
            elWs.on('error', (e) => { 
                clearTimeout(connectionTimeout);
                console.error('=== ELEVENLABS WEBSOCKET ERROR ===');
                console.error('Error details:', e);
                console.error('Error message:', e.message);
                console.error('Error stack:', e.stack);
                console.error('WebSocket state:', elWs.readyState);
                console.error('Error occurred at timestamp:', Date.now());
                console.error('Connection attempt failed for voice ID:', ELEVEN_VOICE_ID);
                endTTS(); 
            });
            
            // Handle unexpected disconnections
            elWs.on('unexpected-response', (request, response) => {
                console.error('=== ELEVENLABS UNEXPECTED RESPONSE ===');
                console.error('Status code:', response.statusCode);
                console.error('Status message:', response.statusMessage);
                console.error('Response headers:', response.headers);
                stopTTS();
            });
        }

        // Helper: send session update to OpenAI
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    model: 'gpt-4o-realtime-preview-2024-10-01',
                    modalities: ["text"],              // <- only text out
                    input_audio_format: 'g711_ulaw',   // keep inbound audio from Twilio
                    // Remove voice field - let OpenAI use default since we only want text
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.55,
                        prefix_padding_ms: 200,
                        silence_duration_ms: SILENCE_MS,
                        create_response: true,         // OpenAI auto-generates responses
                        interrupt_response: true
                    },
                    max_response_output_tokens: 120,
                    instructions: SYSTEM_MESSAGE
                }
            };
            console.log('=== SENDING SESSION UPDATE ===');
            console.log('Session update payload:', JSON.stringify(sessionUpdate, null, 2));
            
            try {
                openAiWs.send(JSON.stringify(sessionUpdate));
                console.log('Session update sent successfully');
            } catch (error) {
                console.error('=== ERROR SENDING SESSION UPDATE ===');
                console.error('Error details:', error);
                console.error('Error message:', error.message);
                console.error('WebSocket state:', openAiWs.readyState);
                
                // Retry after a delay if the connection is still open
                if (openAiWs.readyState === WebSocket.OPEN) {
                    console.log('Retrying session update in 2 seconds...');
                    setTimeout(sendSessionUpdate, 2000);
                }
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('=== OPENAI WEBSOCKET OPENED ===');
            console.log('Connected to the OpenAI Realtime API');
            console.log('Sending session update in 250ms...');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
            
            // No more complex intervals - clean audio handling
        });
        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                
                // Enhanced logging for all response types
                console.log(`Received OpenAI event: ${response.type}`);
                
                // Log the full response for debugging
                console.log('Full response:', JSON.stringify(response, null, 2));
                
                // Special handling for specific event types
                if (response.type === 'session.updated') {
                    openaiReady = true;
                    console.log('=== RESETTING BUFFER FOR NEW SESSION ===');
                    console.log('Previous bytesBuffered:', bytesBuffered);
                    bytesBuffered = 0; // Reset audio buffer for new session
                    collecting = false;
                    console.log('=== SESSION UPDATED ===');
                    console.log('Realtime session configured. You can now forward audio.');
                    console.log('Audio buffer reset for new session');
                    console.log('Session details:', response);
                }
                
                // Also handle session.created but don't set ready yet - wait for our update
                if (response.type === 'session.created') {
                    console.log('=== SESSION CREATED ===');
                    console.log('Initial session created, waiting for our configuration...');
                    // Don't set openaiReady yet - wait for session.updated after our session.update
                }
                
                // Enhanced error logging for response.done events
                if (response.type === 'response.done') {
                    console.log('=== RESPONSE.DONE EVENT ===');
                    console.log('Response completed with status:', response.status);
                    
                    // Log detailed error information if present
                    if (response.status_details && response.status_details.error) {
                        console.error('=== ERROR DETAILS ===');
                        console.error('Error code:', response.status_details.error.code);
                        console.error('Error message:', response.status_details.error.message);
                        console.error('Full error object:', JSON.stringify(response.status_details.error, null, 2));
                    }
                    
                    // Log any other status details
                    if (response.status_details) {
                        console.log('Status details:', JSON.stringify(response.status_details, null, 2));
                    }
                }
                
                // Enhanced error logging for error events
                if (response.type === 'error') {
                    console.error('=== OPENAI ERROR EVENT ===');
                    console.error('Error type:', response.error?.type);
                    console.error('Error code:', response.error?.code);
                    console.error('Error message:', response.error?.message);
                    console.error('Full error object:', JSON.stringify(response.error, null, 2));
                }
                
                // Handle text responses (no more audio since modalities: ["text"])
                if (response.type === 'response.content.delta' && response.delta) {
                    console.log('=== TEXT RESPONSE DELTA ===');
                    console.log('Response text:', response.delta);
                    // You can handle text responses here - log them, store them, etc.
                }
                
                // Handle completed responses and trigger TTS
                if (response.type === 'response.completed' || response.type === 'response.done') {
                    console.log('=== RESPONSE COMPLETED ===');
                    console.log('Full response object:', JSON.stringify(response, null, 2));
                    
                    // Extract the full text from the response
                    const text = (response.response?.output || [])
                        .filter(p => p.type === 'output_text')
                        .map(p => p.text)
                        .join(' ')
                        .trim();
                    
                    console.log('=== EXTRACTED TEXT FOR TTS ===');
                    console.log('Raw text:', text);
                    console.log('Text length:', text.length);
                    console.log('Text is empty?', !text);
                    
                    if (text) {
                        console.log('=== TRIGGERING TTS ===');
                        console.log('Text to speak:', text);
                        console.log('Current TTS state before calling speakWithEleven:', ttsPlaying);
                        speakWithEleven(text);
                    } else {
                        console.log('=== NO TEXT FOUND FOR TTS ===');
                        console.log('Response structure:', JSON.stringify(response.response, null, 2));
                        console.log('Output array:', response.response?.output);
                    }
                    return;
                }
                
                // Log any other important events that might contain errors
                if (response.type === 'session.error' || response.type === 'input_audio_buffer.error') {
                    console.error(`=== ${response.type.toUpperCase()} ===`);
                    console.error('Error details:', JSON.stringify(response, null, 2));
                }
                
                // Handle successful audio buffer commit
                if (response.type === 'input_audio_buffer.committed') {
                    console.log('=== AUDIO BUFFER COMMITTED ===');
                    console.log('OpenAI successfully committed audio buffer');
                    console.log('Response details:', JSON.stringify(response, null, 2));
                    
                    // Now it's safe to reset the buffer for the next turn
                    console.log('=== RESETTING BUFFER AFTER SUCCESSFUL COMMIT ===');
                    console.log('Previous bytesBuffered:', bytesBuffered);
                    bytesBuffered = 0;
                    collecting = false;
                    console.log('Buffer reset complete - bytesBuffered:', bytesBuffered);
                    console.log('Audio buffer reset for next turn');
                }
                
                // Handle conversation item creation
                if (response.type === 'conversation.item.created') {
                    console.log('=== CONVERSATION ITEM CREATED ===');
                    console.log('User audio processed, waiting for AI response...');
                }
                
                // Handle audio buffer events
                if (response.type === 'input_audio_buffer.speech_started') {
                    console.log('=== SPEECH STARTED ===');
                    console.log('User started speaking, audio buffer active');
                }
                
                if (response.type === 'input_audio_buffer.speech_stopped') {
                    console.log('=== SPEECH STOPPED ===');
                    console.log('User stopped speaking, checking audio buffer...');
                    
                    // Note: We no longer rely on this event for commits
                    // Our silence-based timer handles this more reliably
                    console.log('Speech stopped event received, but using our own commit logic');
                }
                
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });
        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                switch (data.event) {
                    case 'media':
                        // Barge-in: if caller speaks while we're playing TTS, stop TTS
                        if (ttsPlaying) {
                            console.log('=== BARGE-IN DETECTED ===');
                            stopTTS();
                        }
                        
                        if (openAiWs.readyState === WebSocket.OPEN && openaiReady) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            
                            // Clean byte-based audio tracking
                            if (!collecting) {
                                collecting = true;
                                console.log('=== STARTED COLLECTING AUDIO ===');
                            }
                            
                            const rawLength = Buffer.from(data.media.payload, 'base64').length;
                            const previousBytes = bytesBuffered;
                            bytesBuffered += rawLength;
                            
                            console.log('=== SENDING AUDIO TO OPENAI ===');
                            console.log('Previous bytes buffered:', previousBytes);
                            console.log('New audio chunk size:', rawLength, 'bytes');
                            console.log('Updated bytes buffered:', bytesBuffered, 'bytes');
                            console.log('Total frames collected:', Math.floor(bytesBuffered / FRAME_BYTES));
                            console.log('WebSocket state:', openAiWs.readyState);
                            console.log('OpenAI ready:', openaiReady);
                            
                            try {
                                openAiWs.send(JSON.stringify(audioAppend));
                                console.log('Audio sent successfully to OpenAI');
                                
                                // Set up silence timer for commit
                                if (silenceTimer) {
                                    clearTimeout(silenceTimer);
                                    console.log('=== CLEARED PREVIOUS SILENCE TIMER ===');
                                }
                                
                                console.log('=== SETTING SILENCE TIMER ===');
                                console.log('Silence duration:', SILENCE_MS, 'ms');
                                console.log('Timer will trigger commitAudioBuffer()');
                                
                                silenceTimer = setTimeout(() => {
                                    console.log('=== SILENCE TIMER TRIGGERED ===');
                                    console.log('Silence timer fired after', SILENCE_MS, 'ms');
                                    console.log('Current buffer state - bytesBuffered:', bytesBuffered);
                                    commitAudioBuffer();
                                }, SILENCE_MS);
                                
                            } catch (error) {
                                console.error('=== ERROR SENDING AUDIO TO OPENAI ===');
                                console.error('Error details:', error);
                                console.error('Error message:', error.message);
                                console.error('WebSocket state:', openAiWs.readyState);
                            }
                        } else {
                            if (!openaiReady) {
                                console.log('OpenAI not ready yet, buffering audio...');
                            } else {
                                console.warn('WebSocket not ready for audio. State:', openAiWs.readyState);
                            }
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    case 'stop':
                        // Stream stopped - just log it
                        console.log('Stream stopped event received');
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });
        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            stopTTS(); // Clean up ElevenLabs connection
            console.log('Client disconnected.');
        });
        // Handle WebSocket close and errors
        openAiWs.on('close', (code, reason) => {
            console.log('=== OPENAI WEBSOCKET CLOSED ===');
            console.log('Close code:', code);
            console.log('Close reason:', reason);
            console.log('WebSocket state:', openAiWs.readyState);
        });
        
        openAiWs.on('error', (error) => {
            console.error('=== OPENAI WEBSOCKET ERROR ===');
            console.error('Error details:', error);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
            console.error('WebSocket state:', openAiWs.readyState);
        });
        
        // Clean audio handling - no more complex functions needed
        
        // Add error handling for the Twilio connection
        connection.on('error', (error) => {
            console.error('=== TWILIO CONNECTION ERROR ===');
            console.error('Error details:', error);
            console.error('Error message:', error.message);
        });
    });
});
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on 0.0.0.0:${PORT}`);
});