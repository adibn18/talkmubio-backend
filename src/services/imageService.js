import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import { bucket, bucketName } from "../config/firebase.js";
import { openai } from "../config/openai.js";

async function storeImageInFirebase(openAIImageUrl) {
  const response = await fetch(openAIImageUrl);
  const buffer = await response.arrayBuffer();
  const uint8Array = new Uint8Array(buffer);

  const fileName = `images/${uuidv4()}.png`;
  const file = bucket.file(fileName);

  const token = uuidv4();

  await file.save(uint8Array, {
    metadata: {
      contentType: "image/png",
      metadata: {
        firebaseStorageDownloadTokens: token,
      },
    },
  });

  const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(
    fileName,
  )}?alt=media&token=${token}`;

  return downloadUrl;
}

export async function generateImage(story, category) {
  try {
    const prompt = `Create a nostalgic, emotional image that represents this family story: ${story.storySummary}.
    Category: ${category.title}. Make it warm, inviting, and suitable for a family memory book.`;

    const response = await openai.images.generate({
      prompt,
      n: 1,
      size: "1024x1024",
    });

    const openaiImageUrl = response.data[0].url;
    return await storeImageInFirebase(openaiImageUrl);
  } catch (error) {
    console.error("Error generating image:", error);
    return null;
  }
}

export async function generateCoverImage(coverDescription) {
  try {
    const prompt = `Create a nostalgic, emotional image of the book that represents this family story: ${coverDescription}.
   Make it warm, inviting, and suitable for a family memory book.`;

    const response = await openai.images.generate({
      prompt,
      n: 1,
      size: "1024x1024",
    });

    const openaiImageUrl = response.data[0].url;
    return await storeImageInFirebase(openaiImageUrl);
  } catch (error) {
    console.error("Error generating image:", error);
    return null;
  }
}