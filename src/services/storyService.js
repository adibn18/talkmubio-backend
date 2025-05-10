import { db } from "../config/firebase.js";
import { openai } from "../config/openai.js";
import { generateImage } from "./imageService.js";

export async function updateStoryWithGPT(story, category, transcript) {
  if (!story?.userId) {
    throw new Error("updateStoryWithGPT: story.userId is missing");
  }
  const userDoc = await db.collection("users").doc(story.userId).get();
  const userData = userDoc.data();
  // const onboardingStoryDoc = await db
  //   .collection("stories")
  //   .doc(userData.onboardingStoryId)
  //   .get();
  // const onboardingStoryData = onboardingStoryDoc.data();
  const storyPreferences = userData?.storyPreferences || {
    narrativeStyle: "first-person",
    lengthPreference: "balanced",
    detailRichness: "balanced",
  };

  // storyService.js
  let onboardingStorySummary = "";
  if (userData?.onboardingStoryId) {
    const onboardingSnap = await db
      .collection("stories")
      .doc(userData.onboardingStoryId)
      .get();

    if (onboardingSnap.exists) {
      onboardingStorySummary = onboardingSnap.data().storySummary || "";
    }
  }
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

async function deleteUpcomingQuestionsForUser(userId) {
  console.log(`Deleting all upcoming questions for user: ${userId}`);

  const upcomingQuestionsRef = db.collection("upcoming_questions");
  const querySnapshot = await upcomingQuestionsRef
    .where("userId", "==", userId)
    .get();

  if (querySnapshot.empty) {
    console.log("No upcoming questions found for this user.");
    return;
  }

  const batch = db.batch();
  querySnapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  console.log(
    `Successfully deleted ${querySnapshot.size} upcoming questions for user: ${userId}`,
  );
}

export async function generateUpcomingQuestions(userId) {
  deleteUpcomingQuestionsForUser(userId);

  console.log("Updating upcoming questions for user: ", userId);

  const storiesRef = db.collection("stories");
  const categoriesRef = db.collection("categories");

  // Fetch all stories for this user
  const storiesSnapshot = await storiesRef.where("userId", "==", userId).get();

  // Filter out stories with categoryId === "0"
  const filteredStories = storiesSnapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((story) => story.categoryId && story.categoryId !== "0");

  // Sort by lastUpdatedAt (most recent first)
  const sortedStories = filteredStories
    .sort((a, b) => {
      const bTime = new Date(
        b.sessions?.[
          Object.keys(b.sessions).pop()
        ]?.lastUpdatedAt?.toDate?.() || 0,
      );
      const aTime = new Date(
        a.sessions?.[
          Object.keys(a.sessions).pop()
        ]?.lastUpdatedAt?.toDate?.() || 0,
      );
      return bTime - aTime;
    })
    .slice(0, 5);


  const recentSummaries = sortedStories.map((s) => ({
    storyId: s.id,
    categoryId: s.categoryId,
    storySummary: s.storySummary || "",
    initialQuestion: s.initialQuestion || "",
  }));

  const categoriesSnapshot = await categoriesRef.get();
  const categories = {};
  categoriesSnapshot.docs.forEach((doc) => {
    const data = doc.data();
    categories[doc.id] = {
      title: data.title,
      description: data.description,
    };
  });

  const prompt = {
    role: "system",
    content: `You are an AI that suggests new conversation questions based on recent personal stories and their themes. Each story is linked to a category.

For each story, you will receive:
- The story summary
- The category title and description
- The initial question that led to the story

Use this to understand the user's interests and tone of questions they respond to. Then suggest up to 10 new follow-up questions, each linked to the most relevant categoryId.

Return a JSON object with a single field "questions" containing an array of:
[
  {
    "categoryId": "abc123",
    "question": "What was a moment from your school years that shaped you?"
  }
]

Recent Story Context:
${recentSummaries
  .map(
    (s, idx) =>
      `${idx + 1}. [${categories[s.categoryId]?.title || "Unknown Category"}]\n` +
      `Initial Question: ${s.initialQuestion || "N/A"}\n` +
      `Story Summary: ${s.storySummary || "No summary available."}`,
  )
  .join("\n\n")}

Category Descriptions:
${Object.entries(categories)
  .map(([id, cat]) => `- ${cat.title} (${id}): ${cat.description}`)
  .join("\n")}
`,
  };


  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [prompt],
    response_format: { type: "json_object" }, // Correct usage
  });
  console.log("Completion: ", completion);
  const questionsResponse = JSON.parse(completion.choices[0].message.content);
  const suggestions = questionsResponse.questions || [];


  const upcomingQuestionsRef = db.collection("upcoming_questions");
  const createdAt = new Date();

  const batch = db.batch();
  suggestions.forEach(({ categoryId, question }) => {
    const docRef = upcomingQuestionsRef.doc();
    batch.set(docRef, {
      id: docRef.id,
      userId,
      categoryId,
      categoryTitle: categories[categoryId]?.title || "Unknown",
      question,
      createdAt,
    });
  });

  await batch.commit();
  console.log(`Successfully saved ${suggestions.length} upcoming questions.`);
}

// Delay function
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait until videoComplete is true
export async function waitForVideoCompletionAndLogHistory(
  userId,
  storyRef,
  sessionId,
  callId,
) {
  const MAX_ATTEMPTS = 999;
  const DELAY_MS = 1500; // 3 seconds between checks

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const storySnapshot = await storyRef.get();
    const storyData = storySnapshot.data();
    const session = storyData.sessions?.[sessionId];

    if (session?.videoComplete) {
      const categoryDoc = await db
        .collection("categories")
        .doc(storyData.categoryId)
        .get();

      const callHistoryRef = db
        .collection("users")
        .doc(userId)
        .collection("call_history")
        .doc(callId);

      await callHistoryRef.set({
        storyId: storySnapshot.id,
        sessionId,
        callId,
        creationTime: session.creationTime ?? new Date(),
        lastUpdated: new Date(),
        transcript: session.transcript ?? "",
        transcript_object: session.transcript_object ?? [],
        recording_url: session.recording_url ?? null,
        videoUrl: session.videoUrl ?? null,
        updated: session.updated ?? false,
        videoComplete: true,
        summary: storyData.storySummary ?? null,
        category: categoryDoc?.data()?.title ?? null,
        initialQuestion: storyData.initialQuestion ?? null,
        title: storyData.title ?? null,
      });

      console.log(`Call history saved for ${callId}`);
      return;
    }

    console.log(
      `Waiting for videoComplete... [Attempt ${attempt}/${MAX_ATTEMPTS}]`,
    );
    await delay(DELAY_MS);
  }

  console.warn(
    `Timed out waiting for videoComplete on call ${callId}. Call history not saved.`,
  );
}
