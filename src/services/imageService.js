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
    const prompt = `Create a high-quality, nostalgic image that visually represents this family story:
    
    **Story Summary:** ${story.storySummary}
    
    **Category:** ${category.title}
    
    **Style Guidelines:**
    - Warm, emotional, and inviting atmosphere
    - Suitable for a family memory book
    - Photorealistic or high-quality illustration style
    - Soft lighting and warm color tones
    - Include subtle nostalgic elements
    - Focus on emotional connection rather than literal representation
    
    Avoid clichés and create a unique, meaningful image that captures the essence of the story.`;

    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "hd",
      style: "vivid",
    });

    if (!response.data || !response.data[0]?.url) {
      throw new Error("No image URL returned from OpenAI");
    }
    const openaiImageUrl = response.data[0].url;
    const firebaseImageUrl = await storeImageInFirebase(openaiImageUrl);
    await addImageGenerationMetadata(story.id, prompt, firebaseImageUrl);
    
    return firebaseImageUrl;
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
