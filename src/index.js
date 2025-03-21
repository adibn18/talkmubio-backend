import { config } from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { OpenAI } from "openai";
import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";

// Load environment variables
config();

// Check for required environment variables
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is required");
}

// Service account credentials from environment variables
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

// Initialize Firebase Admin with service account
initializeApp({
  credential: cert(serviceAccount),
});

// Access Firestore
const db = getFirestore();

// Access Firebase Storage
const storage = getStorage();

// Use your actual bucket name. Typically this is something like "project-id.appspot.com"
// But if your bucket is truly named "estomes-32558.firebasestorage.app", replace below:
const bucketName = "estomes-32558.firebasestorage.app";
const bucket = storage.bucket(bucketName);

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const fastify = Fastify({
  logger: true,
});

// Enable CORS
await fastify.register(cors, {
  origin: true,
});

/**
 * Helper function to store an image from a URL into Firebase Storage
 * and return the public URL (assuming you make the file public).
 */
async function storeImageInFirebase(openAIImageUrl) {
  // Fetch the image from OpenAI's URL
  const response = await fetch(openAIImageUrl);
  const buffer = await response.buffer();

  // Create a unique filename in a folder "images/"
  const fileName = `images/${uuidv4()}.png`;
  const file = bucket.file(fileName);

  // Save the file to Firebase Storage
  await file.save(buffer, {
    metadata: { contentType: "image/png" },
  });

  // Make it publicly readable (optional, but presumably needed for direct URL usage)
  await file.makePublic();

  // Return the public URL
  // For publicly readable files, Google Cloud Storage typically uses:
  // https://storage.googleapis.com/<bucket-name>/<file-name>
  return `https://storage.googleapis.com/${bucketName}/${fileName}`;
}

/**
 * Generate an image using the OpenAI Image API, then store in Firebase Storage.
 */
async function generateImage(story, category) {
  try {
    const prompt = `Create a nostalgic, emotional image that represents this family story: ${story.storySummary}.
    Category: ${category.title}. Make it warm, inviting, and suitable for a family memory book.`;

    const response = await openai.images.generate({
      prompt,
      n: 1,
      size: "1024x1024",
    });

    const openaiImageUrl = response.data[0].url;
    // Download image from OpenAI and store in Firebase
    const firebaseImageUrl = await storeImageInFirebase(openaiImageUrl);

    return firebaseImageUrl;
  } catch (error) {
    console.error("Error generating image:", error);
    return null;
  }
}

/**
 * Calls GPT (chat model) to update the story summary, text, etc.
 */
async function updateStoryWithGPT(story, category, transcript) {
  const prompt = {
    role: "system",
    content: `You are an AI assistant helping to analyze and summarize conversations about family stories and memories.

Category Context: ${category.title} - ${category.description}
Initial Question: ${story.initialQuestion}
Previous Summary: ${story.storySummary || "No previous summary"}

Based on the transcript of the conversation, generate a JSON response with the following fields:
- storySummary: A concise summary of all conversations so far
- storyText: A well-formatted narrative combining all the stories shared
- title: A one-line title (only if current title is null)
- description: A 40-50 word description (only if current description is null)

Current Transcript:
${transcript}`,
  };

  // Update this to your actual GPT model name (e.g., "gpt-3.5-turbo", "gpt-4", or "gpt-4o" if you have a custom route).
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [prompt],
    response_format: { type: "json_object" },
  });

  const response = JSON.parse(completion.choices[0].message.content);

  const updateData = {
    storySummary: response.storySummary,
    storyText: response.storyText,
  };

  // Only update title and description if they were null
  if (story.title === null) {
    updateData.title = response.title;
  }
  if (story.description === null) {
    updateData.description = response.description;
  }

  // Generate and update image if it doesn't exist
  if (!story.imageUrl) {
    const imageUrl = await generateImage(story, category);
    if (imageUrl) {
      updateData.imageUrl = imageUrl;
    }
  }

  return updateData;
}

// -----------------------------------------------------------
// Create a global in-memory map to track processed call IDs.
// -----------------------------------------------------------
const callProcessedMap = new Map();

/**
 * Handles the Retell webhook call logic, including concurrency check.
 */
async function handleRetellWebhook(call) {
  const { call_id, recording_url, transcript, transcript_object } = call;

  // If already processed, skip GPT logic to prevent overwrites
  if (callProcessedMap.has(call_id)) {
    console.log(
      `Call ${call_id} is already being processed or has finished processing. Skipping GPT update.`,
    );
    // If you still want to store partial data, you could do minimal updates here.
    return false;
  }

  // Mark this call ID as processed in memory
  callProcessedMap.set(call_id, true);

  try {
    // Search for the story with this call_id in any session
    const storiesRef = db.collection("stories");
    const storiesSnapshot = await storiesRef.get();

    for (const storyDoc of storiesSnapshot.docs) {
      const story = storyDoc.data();
      const sessions = story.sessions || {};

      for (const [sessionId, session] of Object.entries(sessions)) {
        if (session.callId === call_id) {
          // Found the matching session

          // Get category information
          const categoryDoc = await db
            .collection("categories")
            .doc(story.categoryId)
            .get();
          if (!categoryDoc.exists) {
            throw new Error(`Category ${story.categoryId} not found`);
          }

          // Clean up transcript_object
          const cleanedTranscriptObject = transcript_object.map((msg) => ({
            role: msg.role,
            content: msg.content,
            words: msg.words.map((word) => ({
              word: word.word,
              start: word.start,
              end: word.end,
            })),
            ...(msg.metadata && {
              metadata: { response_id: msg.metadata.response_id },
            }),
          }));

          // Update session with Retell data
          sessions[sessionId] = {
            ...session,
            transcript,
            transcript_object: cleanedTranscriptObject,
            recording_url,
          };

          // Only process with GPT if the session hasn't been updated yet
          if (!session.updated) {
            const gptUpdates = await updateStoryWithGPT(
              story,
              categoryDoc.data(),
              transcript,
            );

            console.log("GPT Updates:", gptUpdates);

            // Update the story document with GPT results and mark session as updated
            if (!session.updated) {
              await storyDoc.ref.update({
                sessions: {
                  ...sessions,
                  [sessionId]: {
                    ...sessions[sessionId],
                    updated: true,
                  },
                },
                ...gptUpdates,
                lastUpdationTime: new Date(),
              });
            }
          } else {
            // Just update the session data without GPT processing
            await storyDoc.ref.update({
              sessions,
              lastUpdationTime: new Date(),
            });
          }

          return true;
        }
      }
    }
    // If no matching story found
    return false;
  } catch (error) {
    console.error("Error in handleRetellWebhook:", error);
    // Remove from map so that a retry can happen if needed
    callProcessedMap.delete(call_id);
    throw error;
  }
}

// -----------------------------------------------------------
// Webhook endpoint
// -----------------------------------------------------------
fastify.post("/webhook/retell", async (request, reply) => {
  try {
    const { event, call } = request.body;
    console.log("Received Retell event:", request.body);

    // Only process call_ended events
    if (event !== "call_ended") {
      reply.code(200).send({ status: "ignored" });
      return;
    }

    // Handle the webhook
    const success = await handleRetellWebhook(call);

    if (!success) {
      reply.code(404).send({ error: "No matching story found for this call" });
      return;
    }

    reply.send({ status: "success" });
  } catch (error) {
    request.log.error(error);
    reply.code(400).send({ error: "Failed to process webhook" });
  }
});

// Start the server
try {
  await fastify.listen({ port: 3000 });
  console.log("Server listening on port 3000");
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
