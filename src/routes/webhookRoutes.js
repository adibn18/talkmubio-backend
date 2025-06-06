import { db } from "../config/firebase.js";
import {
  updateStoryWithGPT,
  generateUpcomingQuestions,
  waitForVideoCompletionAndLogHistory,
} from "../services/storyService.js";

// Create a global in-memory map to track processed call IDs
const callProcessedMap = new Map();

async function handleRetellWebhook(call) {
  const { call_id, recording_url, transcript, transcript_object } = call;

  if (callProcessedMap.has(call_id)) {
    console.log(
      `Call ${call_id} is already being processed or has finished processing. Skipping GPT update.`,
    );
    return false;
  }

  callProcessedMap.set(call_id, true);

  try {
    const storiesRef = db.collection("stories");
    const storiesSnapshot = await storiesRef.get();

    for (const storyDoc of storiesSnapshot.docs) {
      const story = storyDoc.data();
      const sessions = story.sessions || {};

      for (const [sessionId, session] of Object.entries(sessions)) {
        if (session.callId === call_id) {
          let categoryDoc = await db
            .collection("categories")
            .doc(story.categoryId)
            .get();
          // if (!categoryDoc.exists) {
          //   categoryDoc = {
          //     title: "Onborading Call",
          //     description: "Get to know the user",
          //   };
          // }

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

          const updates = {
            [`sessions.${sessionId}.transcript`]: transcript,
            [`sessions.${sessionId}.transcript_object`]:
              cleanedTranscriptObject,
            [`sessions.${sessionId}.recording_url`]: recording_url,
            [`sessions.${sessionId}.lastUpdatedAt`]: new Date(),
          };

          if (!session.updated) {
            const gptUpdates = await updateStoryWithGPT(
              story,
              categoryDoc?.data() ?? {
                title: "Onborading Call",
                description: "Get to know the user and extract ALL DETAILS from conversation",
              },
              transcript,
            );

            Object.assign(updates, gptUpdates, {
              [`sessions.${sessionId}.updated`]: true,
            });
          }

          await storyDoc.ref.update(updates);
          waitForVideoCompletionAndLogHistory(
            story.userId,
            storyDoc.ref,
            sessionId,
            call_id,
          );
          generateUpcomingQuestions(story.userId);
          return true;
        }
      }
    }
    return false;
  } catch (error) {
    console.error("Error in handleRetellWebhook:", error);
    callProcessedMap.delete(call_id);
    throw error;
  }
}

export function setupWebhookRoutes(fastify) {
  fastify.post("/webhook/retell", async (request, reply) => {
    try {
      const { event, call } = request.body;
      console.log("Received Retell event:", request.body);

      if (event !== "call_ended") {
        reply.code(200).send({ status: "ignored" });
        return;
      }

      const success = await handleRetellWebhook(call);

      if (!success) {
        reply
          .code(404)
          .send({ error: "No matching story found for this call" });
        return;
      }

      reply.send({ status: "success" });
    } catch (error) {
      request.log.error(error);
      reply.code(400).send({ error: "Failed to process webhook" });
    }
  });
}
