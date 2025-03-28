import { db } from "../config/firebase.js";
import { openai } from "../config/openai.js";
import { generateImage } from "./imageService.js";

export async function updateStoryWithGPT(story, category, transcript) {
  const userDoc = await db.collection("users").doc(story.userId).get();
  const userData = userDoc.data();
  const onboardingStoryDoc = await db
    .collection("stories")
    .doc(userData.onboardingStoryId)
    .get();
  const onboardingStoryData = onboardingStoryDoc.data();
  const storyPreferences = userData?.storyPreferences || {
    narrativeStyle: "first-person",
    lengthPreference: "balanced",
    detailRichness: "balanced",
  };

  const onboardingStorySummary = onboardingStoryData.storySummary;
  const prompt = {
    role: "system",
    content: `You are an AI assistant helping to analyze and summarize conversations about family stories and memories.

  Category Context: ${category.title} - ${category.description}
  Initial Question: ${story.initialQuestion}
  Onboarding Call Summary: ${onboardingStorySummary}
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
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [prompt],
    response_format: { type: "json_object" },
  });

  const response = JSON.parse(completion.choices[0].message.content);
  console.log(response);
  const updateData = {
    storySummary: response.storySummary,
    storyText: response.storyText,
  };

  if (story.title === null) {
    updateData.title = response.title;
  }
  if (story.description === null) {
    updateData.description = response.description;
  }

  if (!story.imageUrl) {
    const imageUrl = await generateImage(story, category);
    if (imageUrl) {
      updateData.imageUrl = imageUrl;
    }
  }

  return updateData;
}

export async function getAgentId(userId, categoryId) {
  try {
    const agentsRef = db.collection("agents");
    const snapshot = await agentsRef.get();

    const matchingAgent = snapshot.docs.find((doc) => {
      const data = doc.data();
      return data.userId === userId && data.categoryId === categoryId;
    });

    if (!matchingAgent) {
      throw new Error("No agent found for this user and category");
    }

    return matchingAgent.data().agentId;
  } catch (error) {
    console.error("Error getting agent ID:", error);
    throw error;
  }
}
