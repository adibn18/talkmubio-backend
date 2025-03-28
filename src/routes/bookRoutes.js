import { db } from "../config/firebase.js";
import {
  generateBookIndex,
  generateBookChapter,
} from "../services/bookService.js";
import { generateCoverImage } from "../services/imageService.js";

export function setupBookRoutes(fastify) {
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

      bookRef = db.collection("users").doc(user_id).collection("books").doc();
      await bookRef.set({
        status: "in-progress",
        createdAt: new Date(),
      });

      const storiesSnapshot = await db
        .collection("stories")
        .where("userId", "==", user_id)
        .where("isOnboardingStory", "in", [false, null])
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

      const bookIndex = await generateBookIndex(stories);
      const coverImageUrl = await generateCoverImage(
        bookIndex.coverDescription,
      );

      const chapters = [];
      let chaptersSoFarSummaries = "";

      for (let i = 0; i < bookIndex.chapters.length; i++) {
        const chapter = bookIndex.chapters[i];
        const story = stories[chapter.storyIndex];

        const chapterContent = await generateBookChapter(
          story,
          chapter.title,
          chaptersSoFarSummaries,
          storyPreferences,
        );

        chapters.push({
          order: i + 1,
          title: chapter.title,
          storyId: story.id,
          story: chapterContent,
          imageUrl: story.imageUrl ?? null,
        });

        if (story.storySummary) {
          chaptersSoFarSummaries += `\n\nTitle: ${chapter.title}\nSummary: ${story.storySummary}`;
        } else {
          chaptersSoFarSummaries += `\n\nTitle: ${chapter.title}\nSummary: (No summary available)`;
        }
      }

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
}
