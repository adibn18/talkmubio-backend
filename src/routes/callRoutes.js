import { db } from "../config/firebase.js";
import { retellClient } from "../config/retell.js";
import { getAgentId } from "../services/storyService.js";

export function setupCallRoutes(fastify) {
  fastify.post("/create-web-call", async (request, reply) => {
    try {
      let {
        userId,
        categoryId,
        question,
        existingStoryId,
        isOnboarding,
        agentId,
      } = request.body;
      console.log("Received Web Call request:", request.body);
      if (
        !(userId && categoryId && question) &&
        !(userId && isOnboarding && agentId)
      ) {
        return reply.code(400).send({ error: "Missing required parameters" });
      }

      agentId = !agentId ? await getAgentId(userId, categoryId) : agentId;
      isOnboarding = !isOnboarding ? false : isOnboarding;
      categoryId = !categoryId ? "0" : categoryId;
      question = !question ? "Onboarding Call" : question;

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

      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.data();
      let onboardingStoryData = "";
      if (!isOnboarding) {
        const onboardingStoryDoc = await db
          .collection("stories")
          .doc(userData.onboardingStoryId)
          .get();
        onboardingStoryData = onboardingStoryDoc.data();
      }

      const createCallResponse = await retellClient.call.createWebCall({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          initial_question: question,
          onboardingData: onboardingStoryData.storySummary,
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
          isOnboardingStory: isOnboarding,
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
