import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
// Load environment variables from .env file
dotenv.config();
// Retrieve the OpenAI API key from environment variables. You must have OpenAI Realtime API access.
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}
// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
// Constants
const SYSTEM_MESSAGE = `You are Sam, our virtual sales rep. Wait silently until I trigger a response. Speak in short, natural sentences. Ask one question, then stop and listen. If the caller interrupts, stop speaking immediately.`;
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
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
        
        // Audio buffer tracking - clean byte-based approach
        let bytesBuffered = 0;
        const FRAME_BYTES = 160;        // μ-law 8kHz, 20 ms = 160 bytes (before base64)
        const MIN_FRAMES = 6;           // 6 x 20 ms = 120 ms (latency tuned)
        let collecting = false;
        
        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    model: 'gpt-4o-realtime-preview-2024-10-01',
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    speed: 0.95,
                    max_response_output_tokens: 120,        // Latency tuned - shorter responses
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.55,
                        prefix_padding_ms: 200,
                        silence_duration_ms: 400,
                        create_response: false,            // <- strict mode
                        interrupt_response: true
                    },
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
                    bytesBuffered = 0; // Reset audio buffer for new session
                    collecting = false;
                    console.log('=== SESSION UPDATED ===');
                    console.log('Realtime session configured. You can now forward audio.');
                    console.log('Audio buffer reset for new session');
                    console.log('Session details:', response);
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
                
                // Handle audio delta responses
                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
                
                // Log any other important events that might contain errors
                if (response.type === 'session.error' || response.type === 'input_audio_buffer.error') {
                    console.error(`=== ${response.type.toUpperCase()} ===`);
                    console.error('Error details:', JSON.stringify(response, null, 2));
                }
                
                // Handle audio buffer events
                if (response.type === 'input_audio_buffer.speech_started') {
                    console.log('=== SPEECH STARTED ===');
                    console.log('User started speaking, audio buffer active');
                }
                
                if (response.type === 'input_audio_buffer.speech_stopped') {
                    console.log('=== SPEECH STOPPED ===');
                    console.log('User stopped speaking, checking audio buffer...');
                    
                    // Only commit if we actually buffered >=100ms
                    const frames = Math.floor(bytesBuffered / FRAME_BYTES);
                    if (frames >= MIN_FRAMES) {
                        console.log('=== COMMITTING AUDIO BUFFER ===');
                        console.log('Frames collected:', frames);
                        console.log('Bytes buffered:', bytesBuffered);
                        
                        try {
                            // Commit the audio buffer
                            openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                            console.log('Audio buffer committed successfully');
                            
                            // Strict Q&A: YOU decide when model speaks
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                            console.log('Response creation triggered');
                        } catch (error) {
                            console.error('=== ERROR COMMITTING AUDIO ===');
                            console.error('Error details:', error);
                        }
                    } else {
                        console.log('=== SKIPPING COMMIT ===');
                        console.log('Too little audio - frames:', frames, '(<', MIN_FRAMES, ')');
                        console.log('Bytes buffered:', bytesBuffered);
                    }
                    
                    // Reset for next turn
                    bytesBuffered = 0;
                    collecting = false;
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
                        if (openAiWs.readyState === WebSocket.OPEN && openaiReady) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            
                            // Clean byte-based audio tracking
                            if (!collecting) collecting = true;
                            const rawLength = Buffer.from(data.media.payload, 'base64').length;
                            bytesBuffered += rawLength;
                            
                            console.log('=== SENDING AUDIO TO OPENAI ===');
                            console.log('Raw audio length:', rawLength + ' bytes');
                            console.log('Bytes buffered:', bytesBuffered + ' bytes');
                            console.log('Frames collected:', Math.floor(bytesBuffered / FRAME_BYTES));
                            console.log('WebSocket state:', openAiWs.readyState);
                            console.log('OpenAI ready:', openaiReady);
                            
                            try {
                                openAiWs.send(JSON.stringify(audioAppend));
                                console.log('Audio sent successfully to OpenAI');
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