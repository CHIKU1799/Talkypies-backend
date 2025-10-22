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

  wss.on('connection', (ws) => {
    console.log('🟢 WebSocket connection opened from Vapi');
    let dgLive = null;
    let rmsHistory = [];

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
            const transcript = event.channel?.alternatives?.[0]?.transcript || '';
            const confidence = event.channel?.alternatives?.[0]?.confidence || null;
            const isFinal = !!event.is_final;
            if (!transcript.trim()) return;
            const [channelIndex] = event.channel_index || [];
            if (channelIndex === undefined) return;
            const label = channelIndex === 0 ? 'CUSTOMER (CH-0)' : 'ASSISTANT (CH-1)';
            if (isFinal) {
              const maxRMS = getMaxRMSInWindow();
              console.log(
                `📤 FINAL transcript ${label}: "${transcript.trim()}" | 🎯 Confidence: ${confidence} | 🎙 Max RMS (last ${RMS_WINDOW_MS}ms): ${maxRMS.toFixed(4)}`
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
        }
      } else {
        if (dgLive?.send) {
          dgLive.send(msg);
          const rms = calculateRMS(msg);
          rmsHistory.push({ rms, time: Date.now() });
        } else {
          console.warn('⚠ Audio chunk received before Deepgram stream ready — dropped');
        }
      }
    });

    ws.on('close', () => {
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