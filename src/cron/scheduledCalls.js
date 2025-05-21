import { db } from "../config/firebase.js";
import { retellClient } from "../config/retell.js";
import { getAgentId } from "../services/storyService.js";
import cron from "node-cron";

// Run every minute
const CRON_SCHEDULE = "* * * * *";

async function processScheduledCalls() {
  try {
    const now = new Date();
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60000);

    // Get all stories with scheduled calls in the next 5 minutes
    const storiesRef = db.collection("stories");
    const snapshot = await storiesRef.get();

    for (const doc of snapshot.docs) {
      const story = { id: doc.id, ...doc.data() };

      if (!story.nextSchedule || story.nextSchedule.status !== "scheduled") {
        continue;
      }

      const scheduledTime = story.nextSchedule.dateTime.toDate();

      // Check if the call is scheduled within the next 5 minutes
      if (scheduledTime > now && scheduledTime <= fiveMinutesFromNow) {
        console.log(`Processing scheduled call for story ${story.id}`);

        try {
          const agentId = await getAgentId(story.userId, story.categoryId);

          let summary =
            "This is the first conversation and there is no previous context.";
          if (story.storySummary) {
            summary = story.storySummary;
          }

          // Create phone call
          const createCallResponse = await retellClient.call.createPhoneCall({
            from_number: "+18188735391",
            to_number: story.nextSchedule.phoneNumber,
            override_agent_id: agentId,
            retell_llm_dynamic_variables: {
              initial_question: story.initialQuestion,
              summary: summary,
            },
          });

          if (!createCallResponse?.call_id) {
            throw new Error("Failed to get call ID");
          }

          const sessionId = `session_${Date.now()}`;

          // Update story with new session and clear schedule
          await doc.ref.update({
            [`sessions.${sessionId}`]: {
              callId: createCallResponse.call_id,
              transcript: null,
              transcript_object: null,
              creationTime: new Date(),
              recording_url: null,
              updated: false,
              videoComplete : true,
            },
            nextSchedule: null,
            lastUpdationTime: new Date(),
          });

          console.log(`Successfully initiated call for story ${story.id}`);
        } catch (error) {
          console.error(
            `Error processing scheduled call for story ${story.id}:`,
            error,
          );

          // Update story to mark schedule as failed
          await doc.ref.update({
            "nextSchedule.status": "failed",
            "nextSchedule.error": error.message,
            lastUpdationTime: new Date(),
          });
        }
      }
    }
  } catch (error) {
    console.error("Error in processScheduledCalls:", error);
  }
}

export function startScheduledCallsCron() {
  console.log("Starting scheduled calls cron job");
  cron.schedule(CRON_SCHEDULE, processScheduledCalls);
}
