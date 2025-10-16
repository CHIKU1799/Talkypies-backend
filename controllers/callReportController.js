import axios from "axios";
import { CallReportModel } from "../models/callrReportModel.js";
import { mongooseConnection } from "../config/mongooseConfig.js";
import { AccessToken } from 'livekit-server-sdk';
import dotenv from 'dotenv';
dotenv.config();
// const VAPI_API_KEY = "2e8fb729-d3a2-4138-b473-37a28497c5d0";
// const backend_url = 'https://api-talkypies.vercel.app/'
//const backend_url = process.env.BACKEND_URL || 'https://backend-robotics-voice-assistance.onrender.com/';
const backend_url = process.env.BACKEND_URL || 'https://talkypies-backend-o5rq.onrender.com';


export const createAssistant = async (req, res) => {
  let { childName, customPrompt , vapiKey , prompt, toyName, customTranscript } = req.body;
  
  if (vapiKey === "null" || vapiKey === "" || vapiKey === undefined) {
  vapiKey = null;
}
  const VAPI_API_KEY = vapiKey || "a40bdb51-da75-4263-bd2f-28cc8f6593ed"; // Default key if none provided
  
  //"b2047282-7b8a-421b-b33d-7abfdbdddcfd" ;
  


  let finalPrompt = `You are a kid assistant, who helps engage kids in a fun playful manner.
   Please be concise in your responses. Use very simple language that kids can understand and use short sentences. 
  Make sure to follow these instruction while replying: ${customPrompt || "Be friendly and helpful."}`;

  

  if(prompt) {
    finalPrompt = prompt;
    finalPrompt += `Make sure to follow these instruction while replying: ${customPrompt || "Be friendly and helpful."}`;
  }
  //           provider: "cartesia",
  //        voiceId: "3b554273-4299-48b9-9aaf-eefd438e3941",
        
  // return res.json({assistantId: "80526715-0b84-4217-bbf0-0a85d9a90b88"}); // For testing purposes, returning a static assistantId
  
  let transcriptionSetup = {};
if(customTranscript) {
  transcriptionSetup = {
          provider: "custom-transcriber",
          server: { url: 'wss://talkypies-backend-o5rq.onrender.com/api/custom-transcriber' },
        };
        
} else {
    transcriptionSetup = {
          provider: "deepgram",
          language: "en-IN"
        };  
}


  try {
    const response = await axios.post(
      "https://api.vapi.ai/assistant",
      {
        name: `Eva-${Date.now()}`,
        model: {
          provider: "openai",
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:  finalPrompt,
            },
          ],
          temperature: 0.3,
        },
         silenceTimeoutSeconds: 30,
        voice: {
          provider: "vapi",
          voiceId: "Neha",
          speed: 0.8
        },
        transcriber: transcriptionSetup,
        // backgroundDenoisingEnabled: true,
        stopSpeakingPlan: {
        backoffSeconds: 4
      },
      
        firstMessage: `Hi ${childName || "there"}! I am ${toyName || "Eva"}! How can I assist you today?`,
        firstMessageMode: "assistant-speaks-first",
        serverMessages: ["end-of-call-report", "function-call"],  
        server: {
          url: `${backend_url}vapi/end-call-report`, // Optional webhook
        },
      },
      {
        headers: {
          Authorization: `Bearer ${VAPI_API_KEY}`,
        },
      }
    );
    // console.log("Assistant created:", response);

    res.json({ assistantId: response.data.id, finalPrompt });
  } catch (error) {
    console.error("Error creating assistant:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create assistant" });
  }
}

export const storeCallReport = async (req, res) => {
  // Ensure mongoose is connected
  await mongooseConnection();

  // console.log("Received request body:", req.body);
     if (req.body.message.type=="end-of-call-report") {
        const  callReport  = req.body.message;
        // console.log("Call Report:", callReport);
        try {
        await  CallReportModel.insertOne(callReport);
        console.log("Call report stored successfully");
            
            // Respond with success
          res.status(200).json({ message: "Call report stored successfully" });
            
        } catch (error) {
          console.error("Error storing call report:", error);
          res.status(500).json({ error: "Failed to store call report" });         
        }

} else {
    res.status(400).json({ error: "Invalid message type" });
  }
};

export const getSessions = async (req, res) => {
  try {
// Ensure mongoose is connected
    await mongooseConnection();

    
    const result = await CallReportModel.aggregate([
  {
    $project: {
      timestamp: 1,
      cost: 1,
      durationSeconds: 1,
      summary: 1,
      recordingUrl: 1,
      durationMinutes: 1
    }
  },
  {
    $facet: {
      data: [
        { $sort: { timestamp: -1 } },        // Sort by timestamp DESC
        { $limit: 20 },  
        {
          $project: {
            timestamp: 1,
            cost: 1,
            durationSeconds: 1,
            summary: 1,
            recordingUrl: 1
          }
        }
      ],
      totals: [
        {
          $group: {
            _id: null,
            totalCost: { $sum: "$cost" },
            totalMinutes: { $sum: "$durationMinutes" },
            totalSessions: { $sum: 1 }
          }
        }
      ]
    }
  }
]);

// Extracting final output
const callData = result[0]?.data || [];
const totals = result[0]?.totals[0] || { totalCost: 0, totalMinutes: 0, totalSessions: 0 };

res.status(200).json({callData, ...totals});

  } catch (error) {
      console.error("Error getting sessions:", error);
      res.status(500).json({ error: "Failed to get sessions" });
  }
};




export const createLiveKitToken = async (req,res) => {
  // If this room doesn't exist, it'll be automatically created when the first
  // participant joins
  const roomName = 'quickstart-room';
  // Identifier to be used for participant.
  // It's available as LocalParticipant.identity with livekit-client SDK
  const participantName = 'quickstart-username';

  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: participantName,
    // Token to expire after 10 minutes
    ttl: '10m',
  });
  at.addGrant({ roomJoin: true, room: roomName });

  const token =  await at.toJwt();
  res.json({ token, roomName, participantName });
};


