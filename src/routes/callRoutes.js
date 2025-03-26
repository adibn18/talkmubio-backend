import { db } from "../config/firebase.js";
import { retellClient } from "../config/retell.js";
import { getAgentId } from "../services/storyService.js";

export function setupCallRoutes(fastify) {
  fastify.post("/create-web-call", async (request, reply) => {
    try {
      const { userId, categoryId, question, existingStoryId } = request.body;

      if (!userId || !categoryId || !question) {
        return reply.code(400).send({ error: "Missing required parameters" });
      }

      const agentId = await getAgentId(userId, categoryId);

      let summary =
        "This is the first conversation and there is no previous context.";

      if (existingStoryId) {
        const storyDoc = await db.doc(`stories/${existingStoryId}`).get();
        if (storyDoc.exists) {
          const storyData = storyDoc.data();
          if (storyData.storySummary) {
            summary = storyData.storySummary;
          }
        }
      }

      const createCallResponse = await retellClient.call.createWebCall({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          initial_question: question,
          summary: summary,
        },
      });

      if (!createCallResponse?.access_token || !createCallResponse?.call_id) {
        throw new Error("Failed to get access token or call ID");
      }

      const sessionId = `session_${Date.now()}`;

      let storyId = existingStoryId;
      if (!existingStoryId) {
        const storyRef = await db.collection("stories").add({
          userId,
          categoryId,
          title: null,
          description: null,
          storyText: null,
          creationTime: new Date(),
          lastUpdationTime: new Date(),
          initialQuestion: question,
          sessions: {},
          storySummary: null,
        });
        storyId = storyRef.id;
      }

      await db.doc(`stories/${storyId}`).update({
        [`sessions.${sessionId}`]: {
          callId: createCallResponse.call_id,
          transcript: null,
          transcript_object: null,
          creationTime: new Date(),
          recording_url: null,
          videoUrl: null,
          updated: false,
        },
        lastUpdationTime: new Date(),
      });

      reply.send({
        accessToken: createCallResponse.access_token,
        callId: createCallResponse.call_id,
        storyId,
        sessionId,
      });
    } catch (error) {
      console.error("Error creating web call:", error);
      reply.code(500).send({ error: error.message });
    }
  });
}
