import { db } from "../config/firebase.js";
import { openai } from "../config/openai.js";
import { generateCoverImage } from "./imageService.js";

export async function generateBookIndex(stories) {
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

  return JSON.parse(completion.choices[0].message.content);
}

export async function generateBookChapter(
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
