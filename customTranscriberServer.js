import { WebSocketServer } from 'ws';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import dotenv from 'dotenv';
dotenv.config();

const DEEPGRAM_API_KEY =
  process.env.DEEPGRAM_API_KEY ||
  '8db50845e951f4d27e920901a1b20468d51d5407';

const RMS_THRESHOLD = 0.03;
const RMS_WINDOW_MS = 2000;

function calculateRMS(buffer) {
  const int16View = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  let sumSquares = 0;
  for (let i = 0; i < int16View.length; i++) {
    const sample = int16View[i] / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / int16View.length);
}

export function attachCustomTranscriberWS(server) {
  const wss = new WebSocketServer({ server, path: '/api/custom-transcriber' });
  const deepgram = createClient(DEEPGRAM_API_KEY);

  console.log('=== Latency logic loaded ===');

  wss.on('connection', (ws) => {
    console.log('🟢 WebSocket connection opened from Vapi');
    let dgLive = null;
    let rmsHistory = [];
    // Latency tracking: stores timestamps for each audio chunk received
    let audioTimestamps = [];
    let utteranceLatencies = []; // Store all per-utterance latencies

    function getMaxRMSInWindow() {
      const now = Date.now();
      rmsHistory = rmsHistory.filter((entry) => now - entry.time <= RMS_WINDOW_MS);
      if (rmsHistory.length === 0) return 0;
      return Math.max(...rmsHistory.map((entry) => entry.rms));
    }

    ws.on('message', (msg, isBinary) => {
      if (!isBinary) {
        let obj;
        try {
          obj = JSON.parse(msg.toString());
        } catch (err) {
          console.error('❌ Invalid JSON from client:', err);
          return;
        }
        console.log('📩 Received JSON message:', obj);
        if (obj.type === 'start') {
          console.log('🚀 Received "start" — initializing Deepgram live transcription');
          dgLive = deepgram.listen.live({
            encoding: obj.encoding || 'linear16',
            sample_rate: obj.sampleRate || 16000,
            channels: obj.channels || 2,
            model: 'nova-3',
            language: obj.language || 'en',
            punctuate: true,
            smart_format: true,
            interim_results: true,
            multichannel: true,
          });

          dgLive.on(LiveTranscriptionEvents.Open, () =>
            console.log('✅ Deepgram WS connection opened')
          );
          dgLive.on(LiveTranscriptionEvents.Error, (err) =>
            console.error('❌ Deepgram error:', err)
          );
          dgLive.on(LiveTranscriptionEvents.Close, (ev) =>
            console.log('🛑 Deepgram connection closed:', ev)
          );
          dgLive.on(LiveTranscriptionEvents.Transcript, (event) => {
            console.log('🗒️ Transcript event received:', event);
            const transcript = event.channel?.alternatives?.[0]?.transcript || '';
            const confidence = event.channel?.alternatives?.[0]?.confidence || null;
            const isFinal = !!event.is_final;
            if (!transcript.trim()) return;
            const [channelIndex] = event.channel_index || [];
            if (channelIndex === undefined) return;
            const label = channelIndex === 0 ? 'CUSTOMER (CH-0)' : 'ASSISTANT (CH-1)';
            if (isFinal) {
              // On final transcript, calculate latency if possible
              console.log('✅ Processing final transcript event');
              const maxRMS = getMaxRMSInWindow();
              let latencyMs = null;
              // Log the state of audioTimestamps for debugging
              console.log(`[LATENCY_LOG] audioTimestamps before shift:`, audioTimestamps);
              if (audioTimestamps.length > 0) {
                const firstAudioTimestamp = audioTimestamps.shift();
                latencyMs = Date.now() - firstAudioTimestamp;
                utteranceLatencies.push(latencyMs); // Track for average
                console.log(`[LATENCY_LOG] audioTimestamps after shift:`, audioTimestamps);
              } else {
                console.log(`[LATENCY_LOG] ⚠️ No audio timestamp found for latency calculation. This may indicate a mismatch between audio chunks and transcript events.`);
              }
              // Log all metrics together
              console.log(
                `📤 FINAL transcript ${label}: "${transcript.trim()}" | 🎯 Confidence: ${confidence} | 🎙 Max RMS (last ${RMS_WINDOW_MS}ms): ${maxRMS.toFixed(4)} | ⏱️ Latency: ${latencyMs !== null ? latencyMs + ' ms' : 'N/A'}`
              );
            } else {
              console.log(
                `📝 Interim transcript ${label}: "${transcript.trim()}" | 🎯 Confidence: ${confidence}`
              );
            }
            if (isFinal) {
              let responseText = transcript.trim();
              if (confidence !== null && confidence < 0.8) {
                responseText = "rephrase i couldn't hear you clearly";
              }
              const maxRMS = getMaxRMSInWindow();
              if (maxRMS < RMS_THRESHOLD) {
                responseText = "rephrase please come closer or speak loudly your voice was not clear";
              }
              ws.send(
                JSON.stringify({
                  type: 'transcriber-response',
                  transcription: responseText,
                  channel: channelIndex === 0 ? 'customer' : 'assistant',
                })
              );
            }
          });
        } else if (obj.type === 'stop') {
          console.log('🛑 Received stop from client');
          if (dgLive?.close) {
            dgLive.close();
          }
        } else {
          console.log('⚠️ Unknown message type:', obj.type);
        }
      } else {
        // When a binary audio chunk is received, record the timestamp
        if (dgLive?.send) {
          const now = Date.now();
          console.log(`🔊 Audio chunk received (binary) at ${now}`);
          console.log(`[LATENCY_LOG] audioTimestamps before push:`, audioTimestamps);
          dgLive.send(msg);
          const rms = calculateRMS(msg);
          rmsHistory.push({ rms, time: now });
          // Push the current time to the array for latency tracking
          audioTimestamps.push(now);
          console.log(`[LATENCY_LOG] audioTimestamps after push:`, audioTimestamps);
        } else {
          console.warn('⚠ Audio chunk received before Deepgram stream ready — dropped');
        }
      }
    });

    ws.on('close', () => {
      // On close, log average latency if any utterances were processed
      let callSummary = {};
      if (utteranceLatencies.length > 0) {
        const sum = utteranceLatencies.reduce((a, b) => a + b, 0);
        const avg = sum / utteranceLatencies.length;
        callSummary = {
          averageLatencyMs: avg,
          utteranceCount: utteranceLatencies.length,
          utteranceLatencies: utteranceLatencies
        };
        console.log(`[LATENCY_LOG] 📊 Average latency for call: ${avg.toFixed(2)} ms over ${utteranceLatencies.length} utterances`);
        console.log(`[LATENCY_LOG] Call summary:`, callSummary);
      } else {
        callSummary = { averageLatencyMs: null, utteranceCount: 0, utteranceLatencies: [] };
        console.log('[LATENCY_LOG] No utterance latencies recorded for this call.');
        console.log(`[LATENCY_LOG] Call summary:`, callSummary);
      }
      console.log('❌ WebSocket connection closed by client; closing Deepgram stream');
      if (dgLive?.close) {
        dgLive.close();
      }
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      if (dgLive?.close) {
        dgLive.close();
      }
    });
  });
}