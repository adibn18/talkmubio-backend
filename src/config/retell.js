// Load environment variables first
import { config } from "dotenv";
config();

import Retell from "retell-sdk";

if (!process.env.RETELL_API_KEY) {
  throw new Error("RETELL_API_KEY environment variable is required");
}

export const retellClient = new Retell({
  apiKey: process.env.RETELL_API_KEY,
});
