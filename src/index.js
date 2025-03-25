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
// async function storeImageInFirebase(openAIImageUrl) {
//   // Fetch the image from OpenAI's URL
//   const response = await fetch(openAIImageUrl);
//   const buffer = await response.buffer();

//   // Create a unique filename in a folder "images/"
//   const fileName = `images/${uuidv4()}.png`;
//   const file = bucket.file(fileName);

//   // Save the file to Firebase Storage
//   await file.save(buffer, {
//     metadata: { contentType: "image/png" },
//   });

//   // Make it publicly readable (optional, but presumably needed for direct URL usage)
//   await file.makePublic();

//   // Return the public URL
//   // For publicly readable files, Google Cloud Storage typically uses:
//   // https://storage.googleapis.com/<bucket-name>/<file-name>
//   return `https://storage.googleapis.com/${bucketName}/${fileName}`;
// }

async function storeImageInFirebase(openAIImageUrl) {
  // 1. Fetch the image buffer (from wherever you're getting it)
  const response = await fetch(openAIImageUrl);
  const buffer = await response.arrayBuffer(); // or response.buffer() in Node
  const uint8Array = new Uint8Array(buffer);

  // 2. Create a unique filename under "images/"
  const fileName = `images/${uuidv4()}.png`;
  const file = bucket.file(fileName);

  // 3. Generate a token to allow download
  const token = uuidv4();

  // 4. Save the file to Firebase Storage, including custom metadata for the token
  await file.save(uint8Array, {
    metadata: {
      contentType: "image/png",
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
    },
  });

  // 5. Construct the Firebase download URL
  //    Format: https://firebasestorage.googleapis.com/v0/b/<bucketName>/o/<path>?alt=media&token=<token>
  const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
    fileName,
  )}?alt=media&token=${token}`;

  return downloadUrl;
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

async function generateCoverImage(coverDescription) {
  try {
    const prompt = `Create a nostalgic, emotional image of the book that represents this family story: ${coverDescription}.
   Make it warm, inviting, and suitable for a family memory book.`;

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

// New helper functions for book creation
async function generateBookIndex(stories) {
  const prompt = {
    role: "system",
    content: `Create a book index from the following stories. Each story has an initial question and story text. Generate a cohesive structure with chapters and a suggested book title. Format the response as JSON with the following structure:
    {
      "title": "Book title",
      "coverDescription": "Description for cover image generation",
      "chapters": [
        {
          "number": 1,
          "title": "Chapter title",
          "storyIndex": 0 // Index of the story in the provided array
        }
      ]
    }

    Stories:
    ${stories
      .map(
        (story, index) => `
    Story ${index + 1}:
    Question: ${story.initialQuestion}
    Text: ${story.storyText}
    `,
      )
      .join("\n")}`,
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [prompt],
    response_format: { type: "json_object" },
  });
  console.log(completion.choices[0].message.content);
  return JSON.parse(completion.choices[0].message.content);
}

async function generateBookChapter(
  story,
  chapterTitle,
  chaptersSoFarSummaries,
  storyPreferences,
) {
  const prompt = {
    role: "system",
    content: `We are creating a cohesive book of multiple chapters. 
So far, these story summaries (NOT full text) have been covered:
${chaptersSoFarSummaries}

Now, generate the next chapter with the title: "${chapterTitle}" based on this new story:
Question: ${story.initialQuestion}
Story Text: ${story.storyText}

Narrative Preferences:
- Narrative Style: ${storyPreferences.narrativeStyle}
  • first-person: Stories written from the speaker's perspective ("I remember...")
  • third-person: Stories written from an observer's perspective ("John remembers...")
- Length Preference: ${storyPreferences.lengthPreference}
  • longer: Comprehensive, detailed stories
  • balanced: Moderate length with key details
  • shorter: Concise, focused stories
- Detail Richness: ${storyPreferences.detailRichness}
  • more: Rich, descriptive narratives with sensory details
  • balanced: Mix of events and descriptive elements
  • fewer: Focus on key events and minimal description

IMPORTANT REQUIREMENTS:
1. Do NOT include any automatic chapter numbering (e.g., "Chapter One," "Chapter Seven").
2. Do NOT use the word "Chapter" at all.
3. Write a cohesive, engaging narrative that can logically follow from the previous stories' *summaries*.
4. Return only the text of the new chapter with no extra headings or metadata.`,
  };

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [prompt],
  });

  return completion.choices[0].message.content;
}

/**
 * Calls GPT (chat model) to update the story summary, text, etc.
 */
async function updateStoryWithGPT(story, category, transcript) {
  const userDoc = await db.collection("users").doc(story.userId).get();
  const userData = userDoc.data();
  const storyPreferences = userData?.storyPreferences || {
    narrativeStyle: "first-person",
    lengthPreference: "balanced",
    detailRichness: "balanced",
  };
  const prompt = {
    role: "system",
    content: `You are an AI assistant helping to analyze and summarize conversations about family stories and memories.

  Category Context: ${category.title} - ${category.description}
  Initial Question: ${story.initialQuestion}
  Previous Summary: ${story.storySummary || "No previous summary"}

  Narrative Preferences:
  - Narrative Style: ${storyPreferences.narrativeStyle}
    • first-person: Stories written from the speaker's perspective ("I remember...")
    • third-person: Stories written from ${userData.name}'s perspective ("${userData.name} remembers...")
  - Length Preference: ${storyPreferences.lengthPreference}
    • longer: Comprehensive, detailed stories
    • balanced: Moderate length with key details
    • shorter: Concise, focused stories
  - Detail Richness: ${storyPreferences.detailRichness}
    • more: Rich, descriptive narratives with sensory details
    • balanced: Mix of events and descriptive elements
    • fewer: Focus on key events and minimal description

  Based on the transcript of the conversation and the narrative preferences above, generate a JSON response with the following fields:

  - storySummary: A concise summary of all conversations so far
  - storyText: A well-formatted narrative combining all the stories shared, following the specified narrative style, length, and detail richness
  - title: A one-line title (only if current title is null)
  - description: A 40-50 word description (only if current description is null)

  Current Transcript:
  ${transcript}`,
  };

  console.log(prompt);
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

fastify.post("/create-book", async (request, reply) => {
  let bookRef;

  try {
    const { user_id } = request.query;
    if (!user_id) {
      reply.code(400).send({ error: "user_id is required" });
      return;
    }

    const userDoc = await db.collection("users").doc(user_id).get();
    const userData = userDoc.data();
    const storyPreferences = userData?.storyPreferences || {
      narrativeStyle: "first-person",
      lengthPreference: "balanced",
      detailRichness: "balanced",
    };

    // 1. Create a new book document (with in-progress status).
    bookRef = db.collection("users").doc(user_id).collection("books").doc();
    await bookRef.set({
      status: "in-progress",
      createdAt: new Date(),
    });

    // 2. Fetch all stories for this user.
    const storiesSnapshot = await db
      .collection("stories")
      .where("userId", "==", user_id)
      .get();

    const stories = storiesSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    if (stories.length === 0) {
      await bookRef.update({ status: "error", error: "No stories found" });
      reply.code(404).send({ error: "No stories found for this user" });
      return;
    }

    // 3. Generate the "index" (chapters array + suggested book title).
    const bookIndex = await generateBookIndex(stories);

    // 4. Generate a cover image (optional).
    const coverImageUrl = await generateCoverImage(bookIndex.coverDescription);

    // 5. Build final chapters array with continuity from story summaries
    const chapters = [];
    let chaptersSoFarSummaries = "";
    // We'll accumulate the story summaries from each prior story
    // so the next chapter knows the gist of what's happened.

    for (let i = 0; i < bookIndex.chapters.length; i++) {
      const chapter = bookIndex.chapters[i];
      // Identify the correct story from the array
      const story = stories[chapter.storyIndex];

      // Use only the summaries so far for context, not entire text
      const chapterContent = await generateBookChapter(
        story,
        chapter.title,
        chaptersSoFarSummaries,
        storyPreferences,
      );

      // Push the newly generated chapter
      chapters.push({
        order: i + 1,
        title: chapter.title,
        storyId: story.id,
        story: chapterContent,
        imageUrl: story.imageUrl ?? null,
      });

      // Append the new story's summary for the next iteration.
      // (Assumes each "story" doc in Firestore has a "storySummary" field.)
      if (story.storySummary) {
        chaptersSoFarSummaries += `\n\nTitle: ${chapter.title}\nSummary: ${story.storySummary}`;
      } else {
        // fallback, if no "storySummary" in doc
        chaptersSoFarSummaries += `\n\nTitle: ${chapter.title}\nSummary: (No summary available)`;
      }
    }

    // 6. Update the book doc with final results
    await bookRef.update({
      status: "completed",
      title: bookIndex.title,
      imageUrl: coverImageUrl,
      chapters,
      updatedAt: new Date(),
    });

    reply.send({
      status: "success",
      bookId: bookRef.id,
      title: bookIndex.title,
      chaptersCount: chapters.length,
    });
  } catch (error) {
    console.error("Error creating book:", error);
    if (bookRef) {
      await bookRef.update({
        status: "error",
        error: error.message,
      });
    }
    reply
      .code(500)
      .send({ error: "Failed to create book", details: error.message });
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
