
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import axios from 'axios';
import { Sender, Message, Contact, Settings } from './types'; // Assuming types are shared
// FIX: Aliased `Content` to `GeminiContent` to prevent potential type name collisions that can cause obscure compilation errors.
import { GoogleGenAI, Type, Content as GeminiContent } from '@google/genai';

dotenv.config();

const app = express();
// FIX: Combined cors() and express.json() into a single app.use() call to resolve a TypeScript overload ambiguity with express.json().
app.use(cors(), express.json());

const PORT = process.env.PORT || 3000;

// Use 'const' as credentials are now immutable, loaded from environment variables.
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.ACCESS_TOKEN || ""; // Use ACCESS_TOKEN from env
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
// FIX: Removed GEMINI_API_KEY to adhere to the guideline of using process.env.API_KEY directly.

// In a real app, this data would come from a database.
// This map must be consistent with the frontend's MOCK_CONTACTS.
const contactPhoneMap: { [key: string]: string } = {
    '1': '+15551234567',
    '2': '+15559876543',
    '3': '+15552223333'
};
const phoneToContactIdMap = Object.fromEntries(
    Object.entries(contactPhoneMap).map(([id, phone]) => [phone.replace('+', ''), id])
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let clients: WebSocket[] = [];

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');
    clients.push(ws);

    ws.on('close', () => {
        clients = clients.filter(client => client !== ws);
        console.log('Client disconnected');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

const broadcast = (message: object) => {
    const data = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
};

// --- ROUTES ---

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'GameLink AI Backend is running.' });
});


// Webhook verification
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.warn(`Webhook verification failed. Mode: ${mode}, Token: ${token}, Expected Token: ${VERIFY_TOKEN}`);
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// Receiving messages from WhatsApp
app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach((entry: any) => {
            entry.changes?.forEach((change: any) => {
                if (change.value.messages) {
                    const message = change.value.messages[0];
                    const from = message.from; // User's phone number
                    const text = message.text.body;

                    console.log(`Message from ${from}: ${text}`);
                    
                    const contactId = phoneToContactIdMap[from];

                    if (contactId) {
                        const incomingMessage = {
                            id: message.id,
                            text: text,
                            timestamp: parseInt(message.timestamp) * 1000,
                            sender: Sender.User
                        };
                        
                        // Broadcast to frontend clients
                        broadcast({ type: 'newMessage', payload: { contactId, message: incomingMessage } });
                    } else {
                        console.warn(`Received message from an unknown number: ${from}. No contactId found.`);
                    }
                }
            });
        });
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// Sending messages from frontend
app.post('/send-message', async (req, res) => {
    const { contactId, message } = req.body;
    
    const to = contactPhoneMap[contactId];

    if (!to || !message) {
        return res.status(400).json({ error: "Missing contact phone number or message" });
    }
    
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error("WhatsApp token or Phone Number ID is not configured on the server.");
        return res.status(500).json({ error: "Server is not configured to send messages." });
    }

    const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

    try {
        await axios.post(WHATSAPP_API_URL, {
            messaging_product: 'whatsapp',
            to: to,
            text: { body: message }
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`Message sent to ${to}`);
        res.status(200).json({ success: true });
    } catch (error: any) {
        console.error('Error sending WhatsApp message:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/broadcast-message', async (req, res) => {
    const { contactIds, message } = req.body as { contactIds: string[], message: string };

    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0 || !message) {
        return res.status(400).json({ error: "Missing contactIds or message" });
    }

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error("WhatsApp token or Phone Number ID is not configured on the server.");
        return res.status(500).json({ error: "Server is not configured to send messages." });
    }

    const WHATSAPP_API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

    const sendMessageToContact = async (contactId: string) => {
        const to = contactPhoneMap[contactId];
        if (!to) {
            console.warn(`No phone number found for contactId: ${contactId}`);
            return { status: 'rejected', reason: `No phone for ${contactId}` };
        }
        try {
            await axios.post(WHATSAPP_API_URL, {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: message }
            }, {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            return { status: 'fulfilled', value: contactId };
        } catch (error: any) {
            console.error(`Failed to send message to ${to}:`, error.response?.data || error.message);
            return { status: 'rejected', reason: `Failed for ${contactId}` };
        }
    };

    const results = await Promise.allSettled(contactIds.map(sendMessageToContact));

    const successfulSends = results.filter(r => r.status === 'fulfilled').length;
    const failedSends = results.length - successfulSends;

    console.log(`Broadcast finished. Success: ${successfulSends}, Failed: ${failedSends}`);

    if (failedSends > 0) {
        return res.status(207).json({ 
            success: true, 
            message: `Broadcast sent with ${failedSends} failure(s).`,
            successful: successfulSends,
            failed: failedSends
        });
    }

    res.status(200).json({ success: true, message: 'Broadcast sent successfully.' });
});

// --- AI Endpoints ---

// FIX: Updated function to use process.env.API_KEY as per the Gemini API guidelines.
const getAiClient = () => {
    if (!process.env.API_KEY) {
        return null;
    }
    return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

app.post('/generate-ai-response', async (req, res) => {
    const { chatHistory, aiTraining, contact } = req.body as { chatHistory: Message[], aiTraining: Settings['aiTraining'], contact: Contact };
    
    const ai = getAiClient();
    if (!ai) {
        return res.status(500).json({ error: "AI is not configured on the server." });
    }

    const contactDetails = `---
You are speaking with: ${contact.name}.
Here's what we know about them:
- Phone: ${contact.phone}
- Favorite Games: ${contact.favoriteGames}
- School/Work: ${contact.school}
- Location: ${contact.location}
- Budget: ${contact.budget}
- Previous Notes: ${contact.notes}
---`;

    const systemInstruction = `You are GameLink AI, a friendly and knowledgeable assistant.
Your goal is to help customers with their gaming gear inquiries and convert them into sales.
---
My Business: ${aiTraining.businessDescription || "A store that sells high-quality gaming peripherals and accessories."}
---
My Writing Style: Emulate this style. ${aiTraining.writingStyle || "Be helpful, slightly informal, and use gaming-related slang where appropriate. Be enthusiastic!"}
---
Rules to Follow: ${aiTraining.rules || "Always greet the customer by name if known. Be proactive in asking questions to understand their needs. Keep replies concise."}
---
${contactDetails}
You are responding to the latest message in the following conversation. Use the customer details provided to personalize your response.`;

    // FIX: Using aliased `GeminiContent` type.
    const contents: GeminiContent[] = chatHistory
      .filter(m => m.sender === Sender.User || m.sender === Sender.AI)
      .map(m => ({
          role: m.sender === Sender.User ? "user" : "model",
          parts: [{ text: m.text }]
      }));

    if (contents.length === 0) {
        return res.status(400).json({ error: "No user message to respond to." });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
            }
        });

        res.status(200).json({ response: response.text });
    } catch (error) {
        console.error("Error generating AI response:", error);
        res.status(500).json({ error: "Failed to generate AI response." });
    }
});

app.post('/generate-admin-suggestions', async (req, res) => {
    const { chatHistory } = req.body as { chatHistory: Message[] };

    const ai = getAiClient();
    if (!ai) {
        return res.status(500).json({ error: "AI is not configured on the server." });
    }
    
    const systemInstruction = `You are an expert sales assistant for GameLink. Your goal is to help the admin quickly respond to customer inquiries. Based on the entire conversation history provided, generate exactly 3 concise, helpful, and distinct reply suggestions for the admin. The suggestions should be things the admin can say next to move the conversation forward. Keep each suggestion under 15 words.`;

    // FIX: Using aliased `GeminiContent` type.
    const contents: GeminiContent[] = chatHistory
        .filter(m => m.sender === Sender.User || m.sender === Sender.AI)
        .map(m => ({
            role: m.sender === Sender.User ? "user" : "model",
            parts: [{ text: m.text }]
        }));

    contents.push({
        role: "user",
        parts: [{ text: "Based on our conversation, what are 3 good replies I could send next?" }]
    });

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        suggestions: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                            description: "An array of exactly 3 suggested replies for the admin."
                        }
                    },
                    required: ['suggestions']
                },
            }
        });
        
        const jsonText = response.text.trim();
        const parsedResponse = JSON.parse(jsonText);
        const suggestions = parsedResponse.suggestions || [];
        res.status(200).json({ suggestions });

    } catch (error) {
        console.error("Error generating admin suggestions:", error);
        res.status(500).json({ error: "Failed to generate admin suggestions." });
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    // A little hack to make sure contactPhoneMap is populated for new contacts added on the frontend
    // In a real app with a DB, this wouldn't be needed.
    const contactId = `contact-${Date.now()}`;
    contactPhoneMap[contactId] = `+1555000${Math.floor(Math.random() * 10000)}`;

});
